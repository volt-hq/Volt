use napi::bindgen_prelude::{AsyncTask, Buffer, Task};
use napi::{Env, Error, Result, Status};
use napi_derive::napi;

const FAILURE: &str = "Could not retain private Windows review diagnostics.";

pub struct WriteWindowsPrivateFileTask {
    path: String,
    data: Vec<u8>,
}

impl Task for WriteWindowsPrivateFileTask {
    type Output = ();
    type JsValue = ();

    fn compute(&mut self) -> Result<()> {
        #[cfg(windows)]
        let result = windows::write_private_file(&self.path, &self.data);
        #[cfg(not(windows))]
        let result = {
            let _ = (&self.path, &self.data);
            Err::<(), _>(std::io::Error::from(std::io::ErrorKind::Unsupported))
        };
        // Native errors can contain private paths. Never pass them to JavaScript.
        result.map_err(|_| Error::new(Status::GenericFailure, FAILURE))
    }

    fn resolve(&mut self, _env: Env, _output: ()) -> Result<()> {
        Ok(())
    }
}

#[napi(js_name = "writeWindowsPrivateFile")]
pub fn write_windows_private_file(
    path: String,
    data: Buffer,
) -> AsyncTask<WriteWindowsPrivateFileTask> {
    AsyncTask::new(WriteWindowsPrivateFileTask {
        path,
        data: data.to_vec(),
    })
}

#[cfg(windows)]
mod windows {
    use std::ffi::c_void;
    use std::fs::{self, File};
    use std::io::{self, Write};
    use std::mem::size_of;
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::fs::MetadataExt;
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use std::path::Path;
    use std::ptr::{null, null_mut};

    type Handle = *mut c_void;
    const FILE_ALL_ACCESS: u32 = 0x001f_01ff;
    const OWNER_SECURITY_INFORMATION: u32 = 1;
    const DACL_SECURITY_INFORMATION: u32 = 4;
    const SE_DACL_PROTECTED: u16 = 0x1000;
    const SE_FILE_OBJECT: i32 = 1;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;

    #[repr(C)]
    struct SecurityDescriptor {
        revision: u8,
        reserved: u8,
        control: u16,
        owner: Handle,
        group: Handle,
        sacl: Handle,
        dacl: Handle,
    }

    #[repr(C)]
    struct SecurityAttributes {
        length: u32,
        descriptor: Handle,
        inherit: i32,
    }

    #[repr(C)]
    struct Acl {
        revision: u8,
        reserved: u8,
        size: u16,
        count: u16,
        reserved2: u16,
    }

    #[repr(C)]
    struct AceHeader {
        kind: u8,
        flags: u8,
        size: u16,
    }

    #[repr(C)]
    struct AllowedAce {
        header: AceHeader,
        mask: u32,
        sid: u32,
    }

    #[link(name = "advapi32")]
    unsafe extern "system" {
        fn OpenProcessToken(process: Handle, access: u32, token: *mut Handle) -> i32;
        fn GetTokenInformation(
            token: Handle,
            class: i32,
            buffer: Handle,
            size: u32,
            needed: *mut u32,
        ) -> i32;
        fn GetLengthSid(sid: Handle) -> u32;
        fn EqualSid(left: Handle, right: Handle) -> i32;
        fn InitializeAcl(acl: Handle, size: u32, revision: u32) -> i32;
        fn AddAccessAllowedAceEx(
            acl: Handle,
            revision: u32,
            flags: u32,
            mask: u32,
            sid: Handle,
        ) -> i32;
        fn InitializeSecurityDescriptor(descriptor: Handle, revision: u32) -> i32;
        fn SetSecurityDescriptorOwner(descriptor: Handle, owner: Handle, defaulted: i32) -> i32;
        fn SetSecurityDescriptorDacl(
            descriptor: Handle,
            present: i32,
            acl: Handle,
            defaulted: i32,
        ) -> i32;
        fn SetSecurityDescriptorControl(descriptor: Handle, mask: u16, bits: u16) -> i32;
        fn GetSecurityDescriptorControl(
            descriptor: Handle,
            control: *mut u16,
            revision: *mut u32,
        ) -> i32;
        fn GetSecurityInfo(
            handle: Handle,
            kind: i32,
            information: u32,
            owner: *mut Handle,
            group: *mut Handle,
            dacl: *mut Handle,
            sacl: *mut Handle,
            descriptor: *mut Handle,
        ) -> u32;
        fn SetSecurityInfo(
            handle: Handle,
            kind: i32,
            information: u32,
            owner: Handle,
            group: Handle,
            dacl: Handle,
            sacl: Handle,
        ) -> u32;
        fn GetAce(acl: Handle, index: u32, ace: *mut Handle) -> i32;
    }

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetCurrentProcess() -> Handle;
        fn LocalFree(memory: Handle) -> Handle;
        fn CreateDirectoryW(path: *const u16, security: *const SecurityAttributes) -> i32;
        fn CreateFileW(
            path: *const u16,
            access: u32,
            share: u32,
            security: *const SecurityAttributes,
            disposition: u32,
            flags: u32,
            template: Handle,
        ) -> Handle;
        fn SetFileInformationByHandle(
            file: Handle,
            class: i32,
            information: *const c_void,
            size: u32,
        ) -> i32;
    }

    fn checked(result: i32) -> io::Result<()> {
        if result == 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        }
    }

    fn denied() -> io::Error {
        io::Error::from(io::ErrorKind::PermissionDenied)
    }

    fn wide(path: &Path) -> io::Result<Vec<u16>> {
        let mut value: Vec<u16> = path.as_os_str().encode_wide().collect();
        if value.contains(&0) {
            return Err(io::ErrorKind::InvalidInput.into());
        }
        value.push(0);
        Ok(value)
    }

    // TOKEN_USER starts with SID_AND_ATTRIBUTES. Pointer-aligned storage keeps
    // both that structure and its embedded SID valid for the entire write.
    fn current_user() -> io::Result<Vec<usize>> {
        let mut raw = null_mut();
        // SAFETY: The process pseudo-handle is valid and raw is an output slot.
        checked(unsafe { OpenProcessToken(GetCurrentProcess(), 0x0008, &mut raw) })?;
        // SAFETY: Successful OpenProcessToken transfers a non-null owned handle.
        let token = unsafe { OwnedHandle::from_raw_handle(raw) };
        let mut needed = 0;
        // SAFETY: A null, zero-sized buffer requests the TOKEN_USER buffer size.
        unsafe { GetTokenInformation(token.as_raw_handle(), 1, null_mut(), 0, &mut needed) };
        if needed < size_of::<Handle>() as u32 {
            return Err(io::Error::last_os_error());
        }
        let mut data = vec![0usize; (needed as usize).div_ceil(size_of::<usize>())];
        // SAFETY: data is aligned and has at least needed bytes of writable storage.
        checked(unsafe {
            GetTokenInformation(
                token.as_raw_handle(),
                1,
                data.as_mut_ptr().cast(),
                needed,
                &mut needed,
            )
        })?;
        Ok(data)
    }

    struct PrivateSecurity {
        acl: Vec<u32>,
        descriptor: SecurityDescriptor,
    }

    impl PrivateSecurity {
        fn new(sid: Handle, directory: bool) -> io::Result<Self> {
            // SAFETY: sid comes from a live TOKEN_USER buffer.
            let length = size_of::<Acl>() + 8 + unsafe { GetLengthSid(sid) } as usize;
            let mut security = Self {
                acl: vec![0u32; length.div_ceil(size_of::<u32>())],
                descriptor: SecurityDescriptor {
                    revision: 0,
                    reserved: 0,
                    control: 0,
                    owner: null_mut(),
                    group: null_mut(),
                    sacl: null_mut(),
                    dacl: null_mut(),
                },
            };
            let acl = security.acl.as_mut_ptr().cast();
            let descriptor = (&mut security.descriptor as *mut SecurityDescriptor).cast();
            // SAFETY: Buffers have the Windows ABI layout, are aligned, and remain
            // alive through creation. The SID is owned by the caller's token buffer.
            unsafe {
                checked(InitializeAcl(acl, length as u32, 2))?;
                checked(AddAccessAllowedAceEx(
                    acl,
                    2,
                    if directory { 3 } else { 0 },
                    FILE_ALL_ACCESS,
                    sid,
                ))?;
                checked(InitializeSecurityDescriptor(descriptor, 1))?;
                checked(SetSecurityDescriptorOwner(descriptor, sid, 0))?;
                checked(SetSecurityDescriptorDacl(descriptor, 1, acl, 0))?;
                checked(SetSecurityDescriptorControl(
                    descriptor,
                    SE_DACL_PROTECTED,
                    SE_DACL_PROTECTED,
                ))?;
            }
            Ok(security)
        }

        fn attributes(&mut self) -> SecurityAttributes {
            SecurityAttributes {
                length: size_of::<SecurityAttributes>() as u32,
                descriptor: (&mut self.descriptor as *mut SecurityDescriptor).cast(),
                inherit: 0,
            }
        }
    }

    struct SecurityInfo {
        descriptor: Handle,
        owner: Handle,
        acl: Handle,
    }

    impl Drop for SecurityInfo {
        fn drop(&mut self) {
            // SAFETY: GetSecurityInfo returns a single LocalAlloc-owned descriptor.
            unsafe { LocalFree(self.descriptor) };
        }
    }

    impl SecurityInfo {
        fn read(file: &File) -> io::Result<Self> {
            let mut info = Self {
                descriptor: null_mut(),
                owner: null_mut(),
                acl: null_mut(),
            };
            // SAFETY: The file handle is live; outputs point into the returned allocation.
            let status = unsafe {
                GetSecurityInfo(
                    file.as_raw_handle(),
                    SE_FILE_OBJECT,
                    OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
                    &mut info.owner,
                    null_mut(),
                    &mut info.acl,
                    null_mut(),
                    &mut info.descriptor,
                )
            };
            if status != 0 {
                return Err(io::Error::from_raw_os_error(status as i32));
            }
            Ok(info)
        }

        fn require_owner(&self, sid: Handle) -> io::Result<()> {
            // SAFETY: Both SIDs remain owned by their live descriptor/token buffers.
            if self.owner.is_null() || unsafe { EqualSid(self.owner, sid) } == 0 {
                return Err(denied());
            }
            Ok(())
        }

        fn verify(&self, sid: Handle, directory: bool) -> io::Result<()> {
            self.require_owner(sid)?;
            let mut control = 0;
            let mut revision = 0;
            // SAFETY: descriptor is the valid allocation returned by GetSecurityInfo.
            checked(unsafe {
                GetSecurityDescriptorControl(self.descriptor, &mut control, &mut revision)
            })?;
            if control & SE_DACL_PROTECTED == 0 || self.acl.is_null() {
                return Err(denied());
            }
            // SAFETY: A non-null DACL from GetSecurityInfo has a valid ACL header.
            if unsafe { (*self.acl.cast::<Acl>()).count } != 1 {
                return Err(denied());
            }
            let mut ace = null_mut();
            // SAFETY: The DACL has exactly one ACE and ace is a valid output pointer.
            checked(unsafe { GetAce(self.acl, 0, &mut ace) })?;
            // SAFETY: GetAce returned a valid ACE. Inspect the common header before
            // accessing the access-allowed mask and SID at its documented offset.
            let header = unsafe { &*ace.cast::<AceHeader>() };
            if header.kind != 0
                || header.flags != if directory { 3 } else { 0 }
                || usize::from(header.size) < size_of::<AllowedAce>()
            {
                return Err(denied());
            }
            // SAFETY: The header identifies a sufficiently large access-allowed ACE.
            let allowed = unsafe { &*ace.cast::<AllowedAce>() };
            if allowed.mask != FILE_ALL_ACCESS {
                return Err(denied());
            }
            let ace_sid = std::ptr::addr_of!(allowed.sid).cast_mut().cast();
            // SAFETY: An access-allowed ACE contains a SID at SidStart.
            if unsafe { EqualSid(ace_sid, sid) } == 0 {
                return Err(denied());
            }
            Ok(())
        }
    }

    fn open(
        path: &[u16],
        access: u32,
        share: u32,
        attributes: *const SecurityAttributes,
        disposition: u32,
        flags: u32,
    ) -> io::Result<File> {
        // SAFETY: path is NUL-terminated and optional attributes live through the call.
        let raw = unsafe {
            CreateFileW(
                path.as_ptr(),
                access,
                share,
                attributes,
                disposition,
                flags,
                null_mut(),
            )
        };
        if raw == -1isize as Handle {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: Successful CreateFileW transfers an owned file/directory handle.
        Ok(unsafe { File::from_raw_handle(raw) })
    }

    pub(super) fn write_private_file(path: &str, data: &[u8]) -> io::Result<()> {
        let path = Path::new(path);
        if !path.is_absolute()
            || path
                .file_name()
                .is_none_or(|name| name.to_string_lossy().contains(':'))
        {
            return Err(io::ErrorKind::InvalidInput.into());
        }
        let file_path = wide(path)?;
        let directory = path.parent().ok_or(io::ErrorKind::InvalidInput)?;
        let directory_path = wide(directory)?;
        let user = current_user()?;
        // SAFETY: A successful TokenUser query starts with a SID pointer.
        let sid = unsafe { *user.as_ptr().cast::<Handle>() };
        let mut directory_security = PrivateSecurity::new(sid, true)?;
        let mut file_security = PrivateSecurity::new(sid, false)?;

        // Inspect before creation too: a dangling junction must not create its target.
        match fs::symlink_metadata(directory) {
            Ok(meta)
                if !meta.is_dir() || meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 =>
            {
                return Err(denied());
            }
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                if let Some(parent) = directory.parent() {
                    fs::create_dir_all(parent)?;
                }
                // SAFETY: Both the path and ACL-aware creation attributes are live.
                if unsafe {
                    CreateDirectoryW(directory_path.as_ptr(), &directory_security.attributes())
                } == 0
                {
                    let error = io::Error::last_os_error();
                    if error.kind() != io::ErrorKind::AlreadyExists {
                        return Err(error);
                    }
                }
            }
            Err(error) => return Err(error),
        }
        // Deny delete sharing to pin the directory while checking its ACL and writing.
        // OPEN_REPARSE_POINT ensures a junction substituted during creation is rejected.
        let directory_handle = open(&directory_path, 0x0006_0080, 3, null(), 3, 0x0220_0000)?;
        let meta = directory_handle.metadata()?;
        if !meta.is_dir() || meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(denied());
        }
        SecurityInfo::read(&directory_handle)?.require_owner(sid)?;
        // SAFETY: The directory and ACL buffer are live. Protecting the DACL disables
        // inheritance without changing permissions on the caller's shared parent.
        let status = unsafe {
            SetSecurityInfo(
                directory_handle.as_raw_handle(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION | 0x8000_0000,
                null_mut(),
                null_mut(),
                directory_security.acl.as_mut_ptr().cast(),
                null_mut(),
            )
        };
        if status != 0 {
            return Err(io::Error::from_raw_os_error(status as i32));
        }
        SecurityInfo::read(&directory_handle)?.verify(sid, true)?;

        // CREATE_NEW installs the protected DACL atomically. Never open or overwrite
        // an existing file, hard link, symlink, or reparse point at the destination.
        let mut file = open(
            &file_path,
            FILE_ALL_ACCESS,
            0,
            &file_security.attributes(),
            1,
            0x0020_0080,
        )?;
        let result = (|| {
            let metadata = file.metadata()?;
            if !metadata.is_file() || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
            {
                return Err(denied());
            }
            SecurityInfo::read(&file)?.verify(sid, false)?;
            file.write_all(data)?;
            file.sync_all()
        })();
        if result.is_err() {
            let delete: u8 = 1;
            // SAFETY: FILE_DISPOSITION_INFO is one BOOLEAN. Delete this exact created
            // file on handle close, without resolving a potentially replaced pathname.
            unsafe {
                SetFileInformationByHandle(
                    file.as_raw_handle(),
                    4,
                    (&delete as *const u8).cast(),
                    1,
                )
            };
        }
        result
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use tempfile::tempdir;

        #[test]
        fn writes_private_unicode_files_without_replacing_existing_content() {
            let root = tempdir().unwrap();
            let path = root.path().join("private 界/record.jsonl");
            let text = path.to_str().unwrap();
            write_private_file(text, b"original\n").unwrap();
            assert_eq!(fs::read(&path).unwrap(), b"original\n");
            assert!(write_private_file(text, b"replacement").is_err());
            assert_eq!(fs::read(&path).unwrap(), b"original\n");
        }

        #[test]
        fn rejects_non_directory_and_alternate_stream_targets() {
            let root = tempdir().unwrap();
            let file = root.path().join("file");
            fs::write(&file, b"unchanged").unwrap();
            assert!(write_private_file(file.join("record").to_str().unwrap(), b"private").is_err());
            assert!(
                write_private_file(
                    root.path().join("file:stream").to_str().unwrap(),
                    b"private"
                )
                .is_err()
            );
            assert_eq!(fs::read(file).unwrap(), b"unchanged");
            assert!(write_private_file("relative/record", b"private").is_err());
        }
    }
}
