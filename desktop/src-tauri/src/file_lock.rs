use std::{fs::File, io};

pub(crate) fn try_lock(file: &File, shared: bool) -> io::Result<()> {
    // std::fs locks are unsupported on Android; bionic exposes the same flock ABI.
    #[cfg(target_os = "android")]
    {
        use std::os::fd::AsRawFd;
        unsafe extern "C" {
            fn flock(fd: i32, operation: i32) -> i32;
        }
        let operation = (if shared { 1 } else { 2 }) | 4; // LOCK_SH/EX | LOCK_NB
        if unsafe { flock(file.as_raw_fd(), operation) } == 0 {
            Ok(())
        } else {
            Err(io::Error::last_os_error())
        }
    }
    #[cfg(not(target_os = "android"))]
    {
        if shared {
            file.try_lock_shared()
        } else {
            file.try_lock()
        }
        .map_err(Into::into)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs::{self, OpenOptions},
        path::PathBuf,
        time::{SystemTime, UNIX_EPOCH},
    };
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            Self(std::env::temp_dir().join(format!(
                    "hub-lock-{}-{}",
                    std::process::id(),
                    SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .unwrap()
                        .as_nanos()
                )))
        }
        fn open(&self) -> File {
            OpenOptions::new()
                .read(true)
                .write(true)
                .create(true)
                .truncate(false)
                .open(&self.0)
                .unwrap()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_file(&self.0);
        }
    }

    #[test]
    fn readers_coexist_and_writer_waits_until_all_readers_close() {
        let f = Fixture::new();
        let a = f.open();
        let b = f.open();
        let writer = f.open();
        try_lock(&a, true).unwrap();
        try_lock(&b, true).unwrap();
        assert_eq!(
            try_lock(&writer, false).unwrap_err().kind(),
            io::ErrorKind::WouldBlock
        );
        drop(a);
        assert_eq!(
            try_lock(&writer, false).unwrap_err().kind(),
            io::ErrorKind::WouldBlock
        );
        drop(b);
        try_lock(&writer, false).unwrap();
    }
    #[test]
    fn writer_excludes_other_handles_and_closing_it_releases_the_lock() {
        let f = Fixture::new();
        let writer = f.open();
        let other = f.open();
        try_lock(&writer, false).unwrap();
        assert_eq!(
            try_lock(&other, true).unwrap_err().kind(),
            io::ErrorKind::WouldBlock
        );
        assert_eq!(
            try_lock(&other, false).unwrap_err().kind(),
            io::ErrorKind::WouldBlock
        );
        drop(writer);
        try_lock(&other, true).unwrap();
    }
}
