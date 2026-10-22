//! Ending the processes descended from a process on Windows, for the processes Volt's daemon starts
//! (daemon-hosted conversations RFC §5.3, worker process tree). Windows keeps a process's parent id after the
//! parent exits and reuses ids quickly, so a parent id alone can name an unrelated process. Here a process
//! counts as a child only if it was created no earlier than its parent, and still names that parent in a
//! snapshot taken once it is open; every process found stays open (so its id cannot be reused) until the
//! sweep is done. macOS and Linux walk their process table in JavaScript instead.

use napi::{Error, Result, Status};
use napi_derive::napi;

#[cfg(any(windows, test))]
use std::collections::{HashMap, HashSet, VecDeque};

/// Each process's children by parent id, from a snapshot of `(process id, parent id)` pairs.
#[cfg(any(windows, test))]
fn children_by_parent(processes: &[(u32, u32)]) -> HashMap<u32, Vec<u32>> {
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    for &(pid, parent) in processes {
        children.entry(parent).or_default().push(pid);
    }
    children
}

/// The processes descended from `roots` (each a process id and its creation time), parents before their
/// children, each with the parent it was found under. `children` lists each running process's children by
/// parent id, and `created` gives a process's creation time, `None` when it cannot be opened (a process that
/// cannot be opened is skipped with its subtree). A process counts as its parent's child only if it was
/// created no earlier than the parent: an older one names an earlier process whose id the parent reused.
#[cfg(any(windows, test))]
fn walk(
    roots: &[(u32, u64)],
    children: &HashMap<u32, Vec<u32>>,
    mut created: impl FnMut(u32) -> Option<u64>,
) -> Vec<(u32, u32)> {
    let mut visited: HashSet<u32> = roots.iter().map(|(pid, _)| *pid).collect();
    let mut queue: VecDeque<(u32, u64)> = roots.iter().copied().collect();
    let mut found = Vec::new();
    while let Some((parent, parent_created)) = queue.pop_front() {
        for &child in children.get(&parent).map(Vec::as_slice).unwrap_or_default() {
            // Process 0 (the idle process) is its own parent.
            if child == 0 || !visited.insert(child) {
                continue;
            }
            let Some(child_created) = created(child) else {
                continue;
            };
            if child_created < parent_created {
                continue;
            }
            found.push((child, parent));
            queue.push_back((child, child_created));
        }
    }
    found
}

/// The processes of `found` (from [`walk`], parents first) that are still what the walk took them for, once
/// each is open: in `parents`, a snapshot taken after they were opened, each still names the parent it was
/// found under, and that parent is one of `roots` or was kept itself. A listed process that exited before it
/// was opened can leave its id to an unrelated process, which then has another parent; one that exited since
/// is missing. Either is dropped, with what it was found to have started.
#[cfg(any(windows, test))]
fn confirmed(roots: &[u32], found: &[(u32, u32)], parents: &HashMap<u32, u32>) -> Vec<u32> {
    let mut kept: HashSet<u32> = roots.iter().copied().collect();
    let mut confirmed = Vec::new();
    for &(pid, parent) in found {
        if kept.contains(&parent) && parents.get(&pid) == Some(&parent) {
            kept.insert(pid);
            confirmed.push(pid);
        }
    }
    confirmed
}

#[cfg(windows)]
mod windows {
    use std::ffi::c_void;
    use std::io;
    use std::mem::size_of;
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};

    type Handle = *mut c_void;
    const TH32CS_SNAPPROCESS: u32 = 0x0000_0002;
    const PROCESS_TERMINATE: u32 = 0x0001;
    const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
    const MAX_PATH: usize = 260;

    #[repr(C)]
    struct ProcessEntry32W {
        size: u32,
        usage: u32,
        process_id: u32,
        default_heap_id: usize,
        module_id: u32,
        threads: u32,
        parent_process_id: u32,
        priority_class_base: i32,
        flags: u32,
        exe_file: [u16; MAX_PATH],
    }

    #[repr(C)]
    #[derive(Default)]
    struct FileTime {
        low: u32,
        high: u32,
    }

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn CreateToolhelp32Snapshot(flags: u32, process_id: u32) -> Handle;
        fn Process32FirstW(snapshot: Handle, entry: *mut ProcessEntry32W) -> i32;
        fn Process32NextW(snapshot: Handle, entry: *mut ProcessEntry32W) -> i32;
        fn OpenProcess(desired_access: u32, inherit_handle: i32, process_id: u32) -> Handle;
        fn GetProcessTimes(
            process: Handle,
            creation: *mut FileTime,
            exit: *mut FileTime,
            kernel: *mut FileTime,
            user: *mut FileTime,
        ) -> i32;
        fn TerminateProcess(process: Handle, exit_code: u32) -> i32;
        #[cfg(test)]
        fn GetExitCodeProcess(process: Handle, exit_code: *mut u32) -> i32;
    }

    /// A process held open: while it is, its id is not reused, even after it exits.
    pub(super) struct Process {
        handle: OwnedHandle,
        pub(super) pid: u32,
        /// When it was created, in 100 ns intervals since 1601.
        pub(super) created: u64,
    }

    /// Open process `pid` to read its creation time and end it; `None` when it cannot be opened (it is gone,
    /// or it is not this user's to end).
    pub(super) fn open(pid: u32) -> Option<Process> {
        // SAFETY: OpenProcess takes no pointers; a non-null result is a handle this function then owns.
        let raw = unsafe {
            OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE,
                0,
                pid,
            )
        };
        if raw.is_null() {
            return None;
        }
        // SAFETY: `raw` is a valid process handle that nothing else owns.
        let handle = unsafe { OwnedHandle::from_raw_handle(raw) };
        let mut creation = FileTime::default();
        let mut exit = FileTime::default();
        let mut kernel = FileTime::default();
        let mut user = FileTime::default();
        // SAFETY: the handle is open with PROCESS_QUERY_LIMITED_INFORMATION, and every pointer is a stack
        // local that outlives the call.
        let read = unsafe {
            GetProcessTimes(
                handle.as_raw_handle(),
                &mut creation,
                &mut exit,
                &mut kernel,
                &mut user,
            )
        };
        if read == 0 {
            return None;
        }
        Some(Process {
            handle,
            pid,
            created: (u64::from(creation.high) << 32) | u64::from(creation.low),
        })
    }

    /// End `process`; whether it was ended (not once it has exited).
    pub(super) fn terminate(process: &Process) -> bool {
        // SAFETY: the handle is open with PROCESS_TERMINATE.
        unsafe { TerminateProcess(process.handle.as_raw_handle(), 1) != 0 }
    }

    /// Whether `process` has exited.
    #[cfg(test)]
    pub(super) fn has_exited(process: &Process) -> bool {
        const STILL_ACTIVE: u32 = 259;
        let mut code = 0;
        // SAFETY: the handle is open with PROCESS_QUERY_LIMITED_INFORMATION, and `code` is a stack local.
        let read = unsafe { GetExitCodeProcess(process.handle.as_raw_handle(), &mut code) };
        read != 0 && code != STILL_ACTIVE
    }

    /// Every running process, with its parent's id.
    pub(super) fn processes() -> io::Result<Vec<(u32, u32)>> {
        // SAFETY: CreateToolhelp32Snapshot takes no pointers; a valid result is a handle this function then
        // owns.
        let raw = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
        // INVALID_HANDLE_VALUE.
        if raw as isize == -1 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: `raw` is a valid snapshot handle that nothing else owns.
        let snapshot = unsafe { OwnedHandle::from_raw_handle(raw) };
        // SAFETY: an all-zero PROCESSENTRY32W is valid; its size is set before it is used.
        let mut entry: ProcessEntry32W = unsafe { std::mem::zeroed() };
        entry.size = size_of::<ProcessEntry32W>() as u32;
        let mut processes = Vec::new();
        // SAFETY: the snapshot handle is valid, and `entry` is a local of the size it declares.
        let mut more = unsafe { Process32FirstW(snapshot.as_raw_handle(), &mut entry) } != 0;
        while more {
            processes.push((entry.process_id, entry.parent_process_id));
            // SAFETY: as above.
            more = unsafe { Process32NextW(snapshot.as_raw_handle(), &mut entry) } != 0;
        }
        Ok(processes)
    }
}

#[cfg(windows)]
type Root = windows::Process;
/// macOS and Linux never hold a process here.
#[cfg(not(windows))]
type Root = std::convert::Infallible;

/// A process held so that the processes descended from it can be ended, while it runs and after it exited:
/// while it is held, its id is not reused. Windows only.
#[napi(
    js_name = "ProcessTree",
    type_tag = "1d8633ad-805b-49f8-b37d-75cf13157989"
)]
pub struct NativeProcessTree {
    root: Option<Root>,
}

#[napi]
impl NativeProcessTree {
    /// End every process descended from the held process, never the process itself, and every process those
    /// start while they are ended; resolves with how many were ended. Nothing once closed.
    #[napi]
    pub fn terminate_descendants(&self) -> Result<u32> {
        match &self.root {
            Some(root) => sweep(root),
            None => Ok(0),
        }
    }

    /// Release the process: its id may be reused once it has exited. Whether it was held.
    #[napi]
    pub fn close(&mut self) -> bool {
        self.root.take().is_some()
    }
}

/// Hold process `pid` to end the processes descended from it; `null` when it cannot be opened (it is gone, or
/// it is not this user's). Windows only: macOS and Linux walk their process table instead.
#[napi(js_name = "openProcessTree")]
pub fn open_process_tree(pid: u32) -> Result<Option<NativeProcessTree>> {
    Ok(open(pid)?.map(|root| NativeProcessTree { root: Some(root) }))
}

#[cfg(windows)]
fn open(pid: u32) -> Result<Option<Root>> {
    Ok(windows::open(pid))
}

#[cfg(not(windows))]
fn open(pid: u32) -> Result<Option<Root>> {
    Err(Error::new(
        Status::GenericFailure,
        format!(
            "openProcessTree {pid}: only Windows holds process trees; macOS and Linux walk their process table"
        ),
    ))
}

/// Passes a sweep makes at most: each ends what the previous ones found, and finds what those started meanwhile.
#[cfg(windows)]
const MAX_PASSES: usize = 8;

/// A snapshot of every running process, as `(process id, parent id)` pairs.
#[cfg(windows)]
fn snapshot() -> Result<Vec<(u32, u32)>> {
    windows::processes().map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("ProcessTree.terminateDescendants: process snapshot: {error}"),
        )
    })
}

#[cfg(windows)]
fn sweep(root: &Root) -> Result<u32> {
    // Everything ended stays held, so a later pass can find what it started before it was ended.
    let mut ended: Vec<windows::Process> = Vec::new();
    let mut count = 0;
    for _ in 0..MAX_PASSES {
        let children = children_by_parent(&snapshot()?);
        let roots: Vec<(u32, u64)> = std::iter::once(root)
            .chain(ended.iter())
            .map(|process| (process.pid, process.created))
            .collect();
        let mut opened: HashMap<u32, windows::Process> = HashMap::new();
        let found = walk(&roots, &children, |pid| {
            let process = windows::open(pid)?;
            let created = process.created;
            opened.insert(pid, process);
            Some(created)
        });
        if found.is_empty() {
            break;
        }
        // What was found is open now, so its ids cannot be reused; a second snapshot drops a process that took
        // a listed process's id before it was opened.
        let parents: HashMap<u32, u32> = snapshot()?.into_iter().collect();
        let root_pids: Vec<u32> = roots.iter().map(|(pid, _)| *pid).collect();
        let kept = confirmed(&root_pids, &found, &parents);
        if kept.is_empty() {
            break;
        }
        // Deepest first, so a parent cannot replace a child that was just ended.
        for pid in kept.iter().rev() {
            if let Some(process) = opened.remove(pid) {
                if windows::terminate(&process) {
                    count += 1;
                }
                ended.push(process);
            }
        }
    }
    Ok(count)
}

#[cfg(not(windows))]
fn sweep(root: &Root) -> Result<u32> {
    match *root {}
}

#[cfg(test)]
mod tests {
    use super::*;

    fn table(edges: &[(u32, u32)]) -> HashMap<u32, Vec<u32>> {
        let processes: Vec<(u32, u32)> = edges
            .iter()
            .map(|&(parent, child)| (child, parent))
            .collect();
        children_by_parent(&processes)
    }

    fn pids(found: &[(u32, u32)]) -> Vec<u32> {
        found.iter().map(|&(pid, _)| pid).collect()
    }

    fn creation_times(times: &[(u32, u64)]) -> impl FnMut(u32) -> Option<u64> {
        let times: HashMap<u32, u64> = times.iter().copied().collect();
        move |pid| times.get(&pid).copied()
    }

    #[test]
    fn finds_every_descendant_parents_first_and_nothing_else() {
        let children = table(&[(10, 11), (10, 12), (11, 13), (13, 14), (20, 21)]);
        let found = walk(
            &[(10, 100)],
            &children,
            creation_times(&[(11, 110), (12, 120), (13, 130), (14, 140), (21, 210)]),
        );
        assert_eq!(found, vec![(11, 10), (12, 10), (13, 11), (14, 13)]);
    }

    #[test]
    fn does_not_follow_a_parent_id_older_than_its_parent() {
        // 11 names 10 as its parent but is older: its parent was an earlier process whose id 10 reused.
        let children = table(&[(10, 11), (11, 12), (10, 13)]);
        let found = walk(
            &[(10, 100)],
            &children,
            creation_times(&[(11, 90), (12, 95), (13, 100)]),
        );
        assert_eq!(pids(&found), vec![13]);
    }

    #[test]
    fn skips_a_process_that_cannot_be_opened_with_its_subtree() {
        let children = table(&[(10, 11), (11, 12), (10, 13)]);
        let found = walk(
            &[(10, 100)],
            &children,
            creation_times(&[(12, 120), (13, 130)]),
        );
        assert_eq!(pids(&found), vec![13]);
    }

    #[test]
    fn walks_from_every_root_and_never_returns_a_root_or_loops() {
        // 0 is its own parent; 30 and 31 name each other.
        let children = table(&[(0, 0), (10, 11), (20, 21), (21, 20), (30, 31), (31, 30)]);
        let found = walk(
            &[(10, 100), (20, 200), (30, 300)],
            &children,
            creation_times(&[(0, 0), (11, 110), (21, 210), (31, 310)]),
        );
        assert_eq!(pids(&found), vec![11, 21, 31]);
    }

    #[test]
    fn keeps_what_still_names_the_parent_it_was_found_under() {
        let found = [(11, 10), (12, 10), (13, 11)];
        let parents: HashMap<u32, u32> = [(11, 10), (12, 10), (13, 11)].into_iter().collect();
        assert_eq!(confirmed(&[10], &found, &parents), vec![11, 12, 13]);
    }

    #[test]
    fn drops_a_reused_id_and_what_it_was_found_to_have_started() {
        // 11 exited after the first snapshot, and an unrelated process (whose parent is 99) took its id before
        // it was opened; the walk then took that process's child 13 for 11's.
        let found = [(11, 10), (12, 10), (13, 11)];
        let parents: HashMap<u32, u32> = [(11, 99), (12, 10), (13, 11)].into_iter().collect();
        assert_eq!(confirmed(&[10], &found, &parents), vec![12]);
    }

    #[test]
    fn drops_a_process_that_exited_since_with_its_subtree() {
        let found = [(11, 10), (12, 10), (13, 11)];
        let parents: HashMap<u32, u32> = [(12, 10), (13, 11)].into_iter().collect();
        assert_eq!(confirmed(&[10], &found, &parents), vec![12]);
    }

    #[test]
    fn confirms_under_every_root() {
        let found = [(11, 10), (21, 20)];
        let parents: HashMap<u32, u32> = [(11, 10), (21, 20)].into_iter().collect();
        assert_eq!(confirmed(&[10, 20], &found, &parents), vec![11, 21]);
    }

    #[cfg(not(windows))]
    #[test]
    fn opening_a_process_tree_is_windows_only() {
        assert!(open_process_tree(std::process::id()).is_err());
    }

    #[cfg(windows)]
    mod on_windows {
        use super::super::windows::{has_exited, open, processes};
        use super::super::*;
        use std::os::windows::process::CommandExt;
        use std::process::{Child, Command, Stdio};
        use std::thread::sleep;
        use std::time::{Duration, Instant};

        /// `cmd /d /c <line>`, the line passed as written.
        fn command(line: &str) -> Child {
            Command::new("cmd")
                .raw_arg(format!("/d /c {line}"))
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .expect("spawn cmd")
        }

        /// The running children of `parent` created no earlier than it, waiting until there is one.
        fn children_of(parent: &windows::Process) -> Vec<u32> {
            let deadline = Instant::now() + Duration::from_secs(10);
            loop {
                let children = children_by_parent(&processes().expect("snapshot"));
                let found = walk(&[(parent.pid, parent.created)], &children, |pid| {
                    open(pid).map(|process| process.created)
                });
                if !found.is_empty() || Instant::now() > deadline {
                    return found.into_iter().map(|(pid, _)| pid).collect();
                }
                sleep(Duration::from_millis(50));
            }
        }

        /// Wait until process `pid`, created at `created`, no longer runs (TerminateProcess returns before
        /// the process has exited).
        fn wait_until_ended(pid: u32, created: u64) {
            let deadline = Instant::now() + Duration::from_secs(10);
            while open(pid)
                .is_some_and(|process| process.created == created && !has_exited(&process))
            {
                assert!(Instant::now() < deadline, "process {pid} still runs");
                sleep(Duration::from_millis(50));
            }
        }

        fn wait_for_exit(child: &mut Child) {
            let deadline = Instant::now() + Duration::from_secs(10);
            while child.try_wait().expect("try_wait").is_none() {
                assert!(
                    Instant::now() < deadline,
                    "process {} did not exit",
                    child.id()
                );
                sleep(Duration::from_millis(50));
            }
        }

        #[test]
        fn ends_the_descendants_of_a_running_process() {
            let mut root = command("ping -n 60 127.0.0.1 >nul");
            let tree = open_process_tree(root.id()).expect("open").expect("held");
            let held = tree.root.as_ref().expect("root");
            let pings: Vec<(u32, u64)> = children_of(held)
                .into_iter()
                .filter_map(|pid| open(pid).map(|process| (pid, process.created)))
                .collect();
            assert!(!pings.is_empty(), "cmd started no child");
            assert!(tree.terminate_descendants().expect("sweep") >= 1);
            for (pid, created) in pings {
                wait_until_ended(pid, created);
            }
            // cmd exits once its command has.
            wait_for_exit(&mut root);
        }

        #[test]
        fn ends_the_descendants_of_a_process_after_it_exited() {
            // cmd starts ping without waiting for it and exits; ping keeps cmd's id as its parent's.
            let mut root = command("start /b ping -n 60 127.0.0.1 >nul");
            let mut tree = open_process_tree(root.id()).expect("open").expect("held");
            let held = tree.root.as_ref().expect("root");
            let pings: Vec<(u32, u64)> = children_of(held)
                .into_iter()
                .filter_map(|pid| open(pid).map(|process| (pid, process.created)))
                .collect();
            assert!(!pings.is_empty(), "cmd started no child");
            wait_for_exit(&mut root);
            assert!(tree.terminate_descendants().expect("sweep") >= 1);
            for (pid, created) in pings {
                wait_until_ended(pid, created);
            }
            assert!(tree.close());
            assert!(!tree.close());
            assert_eq!(tree.terminate_descendants().expect("closed"), 0);
        }
    }
}
