//! Workspace path confinement helpers shared by ACP FS, preview, media, and git.

use std::path::{Component, Path, PathBuf};

/// Normalize a workspace root the webview asked to operate in.
pub fn checked_workspace(cwd: &str) -> Result<PathBuf, String> {
    let trimmed = cwd.trim();
    if trimmed.is_empty() {
        return Err("工作区路径不能为空".into());
    }
    let path = PathBuf::from(trimmed);
    if !path.exists() {
        return Err(format!("工作区不存在：{}", path.display()));
    }
    if !path.is_dir() {
        return Err(format!("工作区不是目录：{}", path.display()));
    }
    path.canonicalize()
        .map_err(|error| format!("无法解析工作区 {}：{error}", path.display()))
}

/// Resolve an existing path and require it to stay inside `workspace`.
pub fn checked_workspace_file(workspace: &Path, requested: &str) -> Result<PathBuf, String> {
    let candidate = PathBuf::from(requested);
    let candidate = if candidate.is_absolute() {
        candidate
    } else {
        workspace.join(candidate)
    };
    let canonical = candidate
        .canonicalize()
        .map_err(|error| format!("无法解析文件 {}：{error}", candidate.display()))?;
    if !canonical.starts_with(workspace) {
        return Err("只能访问当前项目内的文件".into());
    }
    Ok(canonical)
}

/// Resolve a create/write target that may not exist yet, still confined to `workspace`.
pub fn checked_workspace_target(workspace: &Path, requested: &str) -> Result<PathBuf, String> {
    let requested_path = PathBuf::from(requested);
    if requested_path
        .components()
        .any(|component| matches!(component, Component::ParentDir))
    {
        return Err("文件路径不能包含 ..".into());
    }
    let candidate = if requested_path.is_absolute() {
        requested_path
    } else {
        workspace.join(requested_path)
    };
    if candidate.exists() {
        return checked_workspace_file(workspace, &path_for_webview(&candidate));
    }

    let mut ancestor = candidate.as_path();
    while !ancestor.exists() {
        ancestor = ancestor
            .parent()
            .ok_or_else(|| "无法定位文件的现有父目录".to_string())?;
    }
    let canonical_ancestor = ancestor
        .canonicalize()
        .map_err(|error| format!("无法解析父目录 {}：{error}", ancestor.display()))?;
    if !canonical_ancestor.starts_with(workspace) {
        return Err("只能访问当前项目内的文件".into());
    }
    let suffix = candidate
        .strip_prefix(ancestor)
        .map_err(|_| "无法解析项目文件路径".to_string())?;
    Ok(canonical_ancestor.join(suffix))
}

pub fn path_for_webview(path: &Path) -> String {
    let raw = path.to_string_lossy();
    raw.strip_prefix(r"\\?\")
        .unwrap_or(&raw)
        .replace('\\', "/")
}

/// True when `candidate` is a regular file inside `workspace` after canonicalize.
pub fn is_workspace_file(workspace: &Path, candidate: &Path) -> bool {
    let Ok(root) = workspace.canonicalize() else {
        return false;
    };
    let Ok(canonical) = candidate.canonicalize() else {
        return false;
    };
    canonical.is_file() && canonical.starts_with(&root)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        sync::atomic::{AtomicU64, Ordering},
    };

    static NONCE: AtomicU64 = AtomicU64::new(0);

    fn temp_root() -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "grox-sandbox-{}",
            NONCE.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn rejects_paths_outside_workspace() {
        let root = temp_root();
        let workspace = root.join("project");
        fs::create_dir_all(&workspace).unwrap();
        let outside = root.join("secret.txt");
        fs::write(&outside, b"nope").unwrap();
        let workspace = workspace.canonicalize().unwrap();
        assert!(checked_workspace_file(&workspace, outside.to_str().unwrap()).is_err());
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn accepts_relative_paths_inside_workspace() {
        let root = temp_root();
        let workspace = root.join("project");
        fs::create_dir_all(workspace.join("src")).unwrap();
        fs::write(workspace.join("src/a.txt"), b"ok").unwrap();
        let workspace = workspace.canonicalize().unwrap();
        let file = checked_workspace_file(&workspace, "src/a.txt").unwrap();
        assert!(file.ends_with("a.txt"));
        fs::remove_dir_all(root).ok();
    }
}
