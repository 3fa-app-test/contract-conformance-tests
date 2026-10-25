use std::{
    env, fs,
    path::Path,
    process::{self, Command},
};

fn forbidden_path(path: &str) -> bool {
    let p = path.to_ascii_lowercase();
    let file = p.rsplit('/').next().unwrap_or(&p);
    p.ends_with(".py")
        || p.ends_with(".pyi")
        || p.ends_with(".pyw")
        || p.ends_with(".ipynb")
        || file == "pipfile"
        || file == "pipfile.lock"
        || file == "poetry.lock"
        || file == "pyproject.toml"
        || file == "uv.lock"
        || file == "setup.py"
        || file == "tox.ini"
        || file == ".python-version"
        || file == "pdm.lock"
        || (file.starts_with("requirements") && file.ends_with(".txt"))
}

fn is_execution_surface(path: &str) -> bool {
    let p = path.to_ascii_lowercase();
    let file = p.rsplit('/').next().unwrap_or(&p);
    (p.starts_with(".github/workflows/") && (p.ends_with(".yaml") || p.ends_with(".yml")))
        || (p.starts_with(".github/actions/") && (p.ends_with(".yaml") || p.ends_with(".yml")))
        || file == "makefile"
        || file == "justfile"
        || p.ends_with(".sh")
        || p.ends_with(".bash")
        || p.ends_with(".zsh")
}

fn forbidden_execution_line(line: &str) -> bool {
    let l = line.trim().to_ascii_lowercase();
    if l.starts_with('#') {
        return false;
    }
    [
        "actions/setup-python@",
        "python -m ",
        "python3 -m ",
        "python -c ",
        "python3 -c ",
        "python ",
        "python3 ",
        "pypy ",
        "pypy3 ",
        "pip install",
        "pip3 install",
        "uv run ",
        "pytest ",
        "poetry run ",
        "pdm run ",
    ]
    .iter()
    .any(|needle| l.contains(needle))
}

fn python_shebang(body: &str) -> bool {
    let first = body
        .lines()
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    first.starts_with("#!")
        && (first.contains("/python")
            || first.contains("env python")
            || first.contains("env -s python")
            || first.contains("/pypy")
            || first.contains("env pypy"))
}

fn violations(path: &str, body: &str) -> Vec<String> {
    let mut messages = Vec::new();
    if forbidden_path(path) {
        messages
            .push("Python source, notebook, dependency manifest, or environment file".to_string());
    }
    if python_shebang(body) {
        messages.push("Python/PyPy shebang".to_string());
    }
    if is_execution_surface(path) {
        for (index, line) in body.lines().enumerate() {
            if forbidden_execution_line(line) {
                messages.push(format!("Python tooling invocation at line {}", index + 1));
            }
        }
    }
    messages
}

fn main() {
    let root = env::args().nth(1).unwrap_or_else(|| ".".to_string());
    let output = Command::new("git")
        .args(["-C", &root, "ls-files", "-z"])
        .output()
        .expect("git must be installed");
    if !output.status.success() {
        eprintln!("git ls-files failed");
        process::exit(2);
    }

    let mut found = 0usize;
    for raw in output
        .stdout
        .split(|byte| *byte == 0)
        .filter(|v| !v.is_empty())
    {
        let name = String::from_utf8_lossy(raw);
        let file = Path::new(&root).join(name.as_ref());

        // Path-only checks still apply even when the content is binary or unreadable.
        let body = fs::read_to_string(&file).unwrap_or_default();
        for problem in violations(&name, &body) {
            eprintln!("{name}: {problem}");
            found += 1;
        }
    }

    if found > 0 {
        eprintln!("{found} Python policy violation(s)");
        process::exit(1);
    }
    println!("Rust-only tooling policy check passed");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocks_python_assets_and_manifests() {
        for path in [
            "tool/doit.py",
            "tool/doit.pyw",
            "types/x.pyi",
            "tests/a.ipynb",
            "pyproject.toml",
            "requirements-dev.txt",
            "Pipfile.lock",
            ".python-version",
            "tox.ini",
        ] {
            assert!(forbidden_path(path), "must reject {path}");
        }
        assert!(!forbidden_path("README.md"));
        assert!(!forbidden_path("src/main.rs"));
    }

    #[test]
    fn recognizes_execution_surfaces() {
        assert!(is_execution_surface(".github/workflows/ci.yml"));
        assert!(is_execution_surface(".github/actions/check/action.yaml"));
        assert!(is_execution_surface("scripts/check.sh"));
        assert!(is_execution_surface("Makefile"));
        assert!(is_execution_surface("justfile"));
        assert!(!is_execution_surface("docs/policy.md"));
    }

    #[test]
    fn blocks_python_ci_invocations() {
        assert!(forbidden_execution_line("- uses: actions/setup-python@v5"));
        assert!(forbidden_execution_line("- run: python3 -m pytest"));
        assert!(forbidden_execution_line("pip install -r requirements.txt"));
        assert!(forbidden_execution_line("uv run tool.py"));
        assert!(!forbidden_execution_line("- run: cargo test"));
    }

    #[test]
    fn blocks_extensionless_python_scripts() {
        assert!(python_shebang("#!/usr/bin/env python3\nprint('x')"));
        assert!(python_shebang("#!/usr/bin/python\nprint('x')"));
        assert!(python_shebang("#!/usr/bin/env pypy3\nprint('x')"));
        assert!(!python_shebang("#!/usr/bin/env bash\necho ok"));
    }

    #[test]
    fn prose_is_not_treated_as_execution() {
        let body = "Python is prohibited; replace Python tooling with Rust.";
        assert!(violations("README.md", body).is_empty());
    }
}
