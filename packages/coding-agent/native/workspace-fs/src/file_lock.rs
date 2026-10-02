use crate::{invalid_path, napi_io_error};
use napi::Result;
use napi_derive::napi;
use std::fs::{self, File, OpenOptions, TryLockError};
use std::io;
use std::path::Path;

/// An owned OS lock. Independent acquisitions always use independent file handles.
/// Closing or dropping the handle releases its lock without removing the file.
#[derive(Debug)]
#[napi(
    js_name = "FileLock",
    type_tag = "b6148aab-146b-4ccd-a2fa-f77c38a04c21"
)]
pub struct NativeFileLock {
    file: Option<File>,
}

#[napi]
impl NativeFileLock {
    #[napi]
    pub fn close(&mut self) -> bool {
        self.file.take().is_some()
    }
}

/// The caller must supply a stable path in a private, trusted parent directory.
/// All participants must retain the lock file: unlinking/replacing it would split
/// ownership across different files. This API never truncates or unlinks it.
#[napi(js_name = "tryAcquireFileLock")]
pub fn try_acquire_file_lock(path: String, shared: bool) -> Result<Option<NativeFileLock>> {
    const OPERATION: &str = "tryAcquireFileLock";
    let lock_path = Path::new(&path);
    if !lock_path.is_absolute() || path.contains('\0') {
        return Err(invalid_path(
            OPERATION,
            &path,
            "lock path must be absolute and contain no NUL",
        ));
    }

    // Reject special files before opening (notably FIFOs/devices). The open flags
    // also reject a symlink substituted at the leaf between inspection and open.
    match fs::symlink_metadata(lock_path) {
        Ok(metadata) if !metadata.file_type().is_file() => {
            return Err(invalid_path(
                OPERATION,
                &path,
                "lock path must be a regular file, not a symlink",
            ));
        }
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(napi_io_error(OPERATION, &path, error)),
    }

    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
        // NONBLOCK prevents a substituted FIFO from blocking open. It does not
        // change regular-file locking; try_lock* separately requests no waiting.
        #[cfg(target_os = "linux")]
        options.custom_flags(
            (rustix::fs::OFlags::NOFOLLOW | rustix::fs::OFlags::NONBLOCK).bits() as i32,
        );
        #[cfg(target_os = "macos")]
        {
            const O_NOFOLLOW: i32 = 0x0000_0100;
            const O_NONBLOCK: i32 = 0x0000_0004;
            options.custom_flags(O_NOFOLLOW | O_NONBLOCK);
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
        options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = options
        .open(lock_path)
        .map_err(|error| napi_io_error(OPERATION, &path, error))?;
    let metadata = file
        .metadata()
        .map_err(|error| napi_io_error(OPERATION, &path, error))?;
    if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
        return Err(invalid_path(
            OPERATION,
            &path,
            "opened lock must be a regular file, not a symlink",
        ));
    }

    // std uses flock(LOCK_NB) on Unix and LockFileEx(FAIL_IMMEDIATELY) on Windows.
    // Never clone a locked file or attempt to upgrade a lock on the same handle.
    let acquired = if shared {
        file.try_lock_shared()
    } else {
        file.try_lock()
    };
    match acquired {
        Ok(()) => Ok(Some(NativeFileLock { file: Some(file) })),
        Err(TryLockError::WouldBlock) => Ok(None),
        Err(TryLockError::Error(error)) => Err(napi_io_error(OPERATION, &path, error)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn acquire(path: &Path, shared: bool) -> Result<Option<NativeFileLock>> {
        try_acquire_file_lock(
            path.to_str().expect("UTF-8 fixture path").to_owned(),
            shared,
        )
    }

    #[test]
    fn shared_owners_coexist_until_the_last_owner_releases() {
        let fixture = tempdir().expect("tempdir");
        let path = fixture.path().join("checkout.lock");
        let mut first = acquire(&path, true)
            .expect("first shared")
            .expect("acquired");
        let second = acquire(&path, true)
            .expect("second shared")
            .expect("acquired");
        assert!(
            acquire(&path, false)
                .expect("exclusive contention")
                .is_none()
        );
        assert!(first.close());
        assert!(!first.close());
        assert!(acquire(&path, false).expect("remaining owner").is_none());
        drop(second);
        assert!(
            acquire(&path, false)
                .expect("last owner released")
                .is_some()
        );
        assert!(path.is_file());
    }

    #[test]
    fn exclusive_owner_excludes_independently_opened_shared_and_exclusive_owners() {
        let fixture = tempdir().expect("tempdir");
        let path = fixture.path().join("checkout.lock");
        let mut owner = acquire(&path, false).expect("exclusive").expect("acquired");
        assert!(
            acquire(&path, false)
                .expect("exclusive contention")
                .is_none()
        );
        assert!(acquire(&path, true).expect("shared contention").is_none());
        assert!(owner.close());
        assert!(!owner.close());
        assert!(acquire(&path, true).expect("released shared").is_some());
        assert!(acquire(&path, false).expect("released exclusive").is_some());
    }

    #[test]
    fn dropping_an_exclusive_owner_releases_the_lock() {
        let fixture = tempdir().expect("tempdir");
        let path = fixture.path().join("checkout.lock");
        let owner = acquire(&path, false).expect("exclusive").expect("acquired");
        drop(owner);
        assert!(acquire(&path, false).expect("released exclusive").is_some());
    }

    #[test]
    fn acquisitions_and_release_preserve_existing_contents_and_file() {
        let fixture = tempdir().expect("tempdir");
        let path = fixture.path().join("checkout.lock");
        fs::write(&path, b"retained lock file").expect("write fixture");
        for shared in [true, false] {
            let mut owner = acquire(&path, shared).expect("lock").expect("acquired");
            assert!(owner.close());
            assert_eq!(
                fs::read(&path).expect("read preserved file"),
                b"retained lock file"
            );
        }
    }

    #[test]
    fn invalid_paths_and_io_errors_fail_instead_of_reporting_contention() {
        let fixture = tempdir().expect("tempdir");
        for shared in [true, false] {
            assert!(try_acquire_file_lock("relative.lock".to_owned(), shared).is_err());
            assert!(try_acquire_file_lock(String::new(), shared).is_err());
            assert!(acquire(fixture.path(), shared).is_err());
            assert!(acquire(&fixture.path().join("missing/checkout.lock"), shared).is_err());
            let nul_path = format!("{}\0", fixture.path().display());
            assert!(try_acquire_file_lock(nul_path, shared).is_err());
        }
    }

    #[cfg(unix)]
    #[test]
    fn created_lock_file_is_private() {
        use std::os::unix::fs::PermissionsExt;
        let fixture = tempdir().expect("tempdir");
        let path = fixture.path().join("checkout.lock");
        let _owner = acquire(&path, true).expect("shared").expect("acquired");
        assert_eq!(
            fs::metadata(&path).expect("metadata").permissions().mode() & 0o777,
            0o600
        );
    }

    #[cfg(unix)]
    #[test]
    fn symlink_and_dangling_symlink_leaves_are_rejected_without_touching_targets() {
        use std::os::unix::fs::symlink;
        let fixture = tempdir().expect("tempdir");
        let target = fixture.path().join("target");
        let missing = fixture.path().join("missing");
        fs::write(&target, b"unchanged").expect("write target");
        let link = fixture.path().join("link.lock");
        let dangling = fixture.path().join("dangling.lock");
        symlink(&target, &link).expect("symlink");
        symlink(&missing, &dangling).expect("dangling symlink");
        for shared in [true, false] {
            assert!(acquire(&link, shared).is_err());
            assert!(acquire(&dangling, shared).is_err());
        }
        assert_eq!(fs::read(&target).expect("read target"), b"unchanged");
        assert!(!missing.exists());
    }

    #[cfg(unix)]
    #[test]
    fn non_regular_files_are_rejected() {
        use std::os::unix::net::UnixListener;
        let fixture = tempdir().expect("tempdir");
        let path = fixture.path().join("socket.lock");
        let _socket = UnixListener::bind(&path).expect("bind socket");
        assert!(acquire(&path, true).is_err());
        assert!(acquire(&path, false).is_err());
    }
}
