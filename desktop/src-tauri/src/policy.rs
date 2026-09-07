use std::path::{Path, PathBuf};

pub fn backend_url(line: &str) -> Option<String> {
    let url = line.strip_prefix("BILIMUSIC_URL=")?;
    let port = url.strip_prefix("http://127.0.0.1:")?.parse::<u16>().ok()?;
    (port > 0).then(|| format!("http://127.0.0.1:{port}"))
}

pub fn data_root(base: &Path) -> PathBuf {
    // Electron used the package name (bilimusic), not the display name.
    for name in ["bilimusic", "BiliMusic"] {
        let path = base.join(name);
        if path.join("data").is_dir() {
            return path;
        }
    }
    base.join("bilimusic")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_announced_loopback_port() {
        assert_eq!(
            backend_url("BILIMUSIC_URL=http://127.0.0.1:54321"),
            Some("http://127.0.0.1:54321".into())
        );
        for line in [
            "http://127.0.0.1:1",
            "BILIMUSIC_URL=http://evil.test:1",
            "BILIMUSIC_URL=http://127.0.0.1:0",
            "BILIMUSIC_URL=http://127.0.0.1:123/",
            "BILIMUSIC_URL=http://127.0.0.1:65536",
        ] {
            assert_eq!(backend_url(line), None);
        }
    }

    #[test]
    fn preserves_existing_electron_data() {
        let base = std::env::temp_dir().join(format!("bm-path-test-{}", std::process::id()));
        std::fs::create_dir_all(base.join("BiliMusic/data")).unwrap();
        assert_eq!(
            data_root(&base).canonicalize().unwrap(),
            base.join("BiliMusic").canonicalize().unwrap()
        );
        std::fs::create_dir_all(base.join("bilimusic/data")).unwrap();
        assert_eq!(
            data_root(&base).canonicalize().unwrap(),
            base.join("bilimusic").canonicalize().unwrap()
        );
        std::fs::remove_dir_all(base).unwrap();
    }
}
