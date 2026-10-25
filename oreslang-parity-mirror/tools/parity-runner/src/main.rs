use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const BACKENDS: [(&str, &str); 5] = [
    ("llvm", "LLVM"),
    ("java", "JAVA"),
    ("wasm", "WASM"),
    ("dotnet", "DOTNET"),
    ("js", "JS"),
];

#[derive(Debug, Deserialize)]
struct Manifest {
    cases: Vec<Case>,
}

#[derive(Debug, Deserialize)]
struct Case {
    id: String,
    path: String,
    expected_kind: String,
    expected_value: Option<i32>,
    validation_status: String,
    features: Vec<String>,
}

#[derive(Debug, Serialize)]
struct Invocation {
    status: String,
    exit_code: Option<i32>,
    stdout_hex: String,
    stderr_hex: String,
    duration_ms: u128,
    error: Option<String>,
}

#[derive(Debug, Serialize)]
struct Record {
    case_id: String,
    backend: String,
    source_sha256: String,
    validation_status: String,
    features: Vec<String>,
    status: String,
    compile: Option<Invocation>,
    run: Option<Invocation>,
}

#[derive(Debug, Serialize)]
struct Report {
    schema_version: u32,
    executed: bool,
    cases: usize,
    backends: Vec<String>,
    records: Vec<Record>,
    summary: BTreeMap<String, usize>,
}

fn hex(bytes: &[u8]) -> String {
    const H: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
        out.push(H[(b >> 4) as usize] as char);
        out.push(H[(b & 0x0f) as usize] as char);
    }
    out
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let output = Command::new("sha256sum")
        .arg(path)
        .output()
        .map_err(|e| format!("failed to run sha256sum: {e}"))?;
    if !output.status.success() {
        return Err(format!("sha256sum failed with {:?}", output.status.code()));
    }
    let text = String::from_utf8(output.stdout).map_err(|e| e.to_string())?;
    text.split_whitespace().next().map(str::to_owned)
        .ok_or_else(|| "sha256sum produced no digest".to_string())
}

fn expand(template: &str, source: &Path, artifact: &Path, workdir: &Path) -> Result<Vec<String>, String> {
    let parts = shell_words::split(template).map_err(|e| e.to_string())?;
    Ok(parts.into_iter().map(|p| {
        p.replace("{source}", &source.to_string_lossy())
            .replace("{artifact}", &artifact.to_string_lossy())
            .replace("{workdir}", &workdir.to_string_lossy())
    }).collect())
}

fn invoke(argv: &[String], workdir: &Path, timeout: Duration) -> Invocation {
    if argv.is_empty() {
        return Invocation { status: "infrastructure_error".into(), exit_code: None,
            stdout_hex: String::new(), stderr_hex: String::new(), duration_ms: 0,
            error: Some("empty command".into()) };
    }
    let start = Instant::now();
    let mut child = match Command::new(&argv[0])
        .args(&argv[1..]).current_dir(workdir)
        .stdout(Stdio::piped()).stderr(Stdio::piped()).spawn() {
        Ok(c) => c,
        Err(e) => return Invocation { status: "infrastructure_error".into(), exit_code: None,
            stdout_hex: String::new(), stderr_hex: String::new(), duration_ms: start.elapsed().as_millis(),
            error: Some(e.to_string()) },
    };
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if start.elapsed() >= timeout => {
                let _ = child.kill();
                let _ = child.wait();
                return Invocation { status: "timeout".into(), exit_code: None,
                    stdout_hex: String::new(), stderr_hex: String::new(), duration_ms: start.elapsed().as_millis(),
                    error: None };
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(20)),
            Err(e) => return Invocation { status: "infrastructure_error".into(), exit_code: None,
                stdout_hex: String::new(), stderr_hex: String::new(), duration_ms: start.elapsed().as_millis(),
                error: Some(e.to_string()) },
        }
    }
    match child.wait_with_output() {
        Ok(out) => Invocation { status: "completed".into(), exit_code: out.status.code(),
            stdout_hex: hex(&out.stdout), stderr_hex: hex(&out.stderr), duration_ms: start.elapsed().as_millis(),
            error: None },
        Err(e) => Invocation { status: "infrastructure_error".into(), exit_code: None,
            stdout_hex: String::new(), stderr_hex: String::new(), duration_ms: start.elapsed().as_millis(),
            error: Some(e.to_string()) },
    }
}

fn temp_dir(case_id: &str, backend: &str) -> Result<PathBuf, String> {
    let p = env::temp_dir().join(format!("ores-parity-{}-{}-{}", std::process::id(), case_id, backend));
    if p.exists() { fs::remove_dir_all(&p).map_err(|e| e.to_string())?; }
    fs::create_dir_all(&p).map_err(|e| e.to_string())?;
    Ok(p)
}

fn main() -> Result<(), String> {
    let args: Vec<String> = env::args().collect();
    let execute = args.iter().any(|a| a == "--execute");
    let allow_unvalidated = args.iter().any(|a| a == "--allow-unvalidated");
    let output = args.windows(2).find(|w| w[0] == "--output")
        .map(|w| w[1].clone()).unwrap_or_else(|| "parity-results.json".into());
    let timeout_s: u64 = args.windows(2).find(|w| w[0] == "--timeout")
        .map(|w| w[1].parse::<u64>().map_err(|e| e.to_string())).transpose()?.unwrap_or(30);
    if timeout_s == 0 { return Err("--timeout must be positive".into()); }

    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..").canonicalize().map_err(|e| e.to_string())?;
    let manifest: Manifest = serde_json::from_str(&fs::read_to_string(root.join("manifest.json")).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    let mut records = Vec::new();

    for case in &manifest.cases {
        let source = root.join(&case.path).canonicalize().map_err(|e| format!("{}: {e}", case.path))?;
        if !source.starts_with(&root) || !source.is_file() { return Err(format!("invalid source path: {}", case.path)); }
        let digest = sha256_file(&source)?;
        for &(backend, env_name) in &BACKENDS {
            let mut rec = Record {
                case_id: case.id.clone(), backend: backend.into(), source_sha256: digest.clone(),
                validation_status: case.validation_status.clone(), features: case.features.clone(),
                status: "not_run".into(), compile: None, run: None,
            };
            if !execute {
                records.push(rec); continue;
            }
            if case.validation_status != "validated" && !allow_unvalidated {
                rec.status = "unvalidated".into(); records.push(rec); continue;
            }
            let prefix = format!("ORES_PARITY_{env_name}");
            let compile_tpl = env::var(format!("{prefix}_COMPILE")).ok();
            let run_tpl = env::var(format!("{prefix}_RUN")).ok();
            if compile_tpl.is_none() || (case.expected_kind == "exit" && run_tpl.is_none()) {
                rec.status = "backend_not_configured".into(); records.push(rec); continue;
            }
            let wd = temp_dir(&case.id, backend)?;
            let artifact = wd.join("program");
            let compile_argv = expand(compile_tpl.as_ref().unwrap(), &source, &artifact, &wd)?;
            let comp = invoke(&compile_argv, &wd, Duration::from_secs(timeout_s));
            let comp_status = comp.status.clone();
            let comp_exit = comp.exit_code;
            rec.compile = Some(comp);
            if comp_status != "completed" {
                rec.status = "compile_infrastructure_failure".into();
            } else if case.expected_kind == "compile_reject" {
                rec.status = if comp_exit == Some(0) { "unexpected_compile_success".into() }
                    else { "rejection_unclassified".into() };
            } else if comp_exit != Some(0) {
                rec.status = "compile_failure".into();
            } else {
                let run_argv = expand(run_tpl.as_ref().unwrap(), &source, &artifact, &wd)?;
                let run = invoke(&run_argv, &wd, Duration::from_secs(timeout_s));
                let run_status = run.status.clone();
                let run_exit = run.exit_code;
                rec.run = Some(run);
                rec.status = if run_status != "completed" { "runtime_infrastructure_failure".into() }
                    else if run_exit != case.expected_value { "wrong_result".into() }
                    else if case.validation_status == "validated" { "pass".into() }
                    else { "exploratory_match_not_parity_pass".into() };
            }
            let _ = fs::remove_dir_all(wd);
            records.push(rec);
        }
    }
    let mut summary = BTreeMap::new();
    for r in &records { *summary.entry(r.status.clone()).or_insert(0) += 1; }
    let report = Report { schema_version: 1, executed: execute, cases: manifest.cases.len(),
        backends: BACKENDS.iter().map(|x| x.0.to_string()).collect(), records, summary };
    fs::write(&output, serde_json::to_vec_pretty(&report).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    println!("{}", serde_json::to_string(&report.summary).map_err(|e| e.to_string())?);
    let hard_fail = report.records.iter().any(|r| matches!(r.status.as_str(),
        "compile_failure" | "wrong_result" | "unexpected_compile_success" |
        "compile_infrastructure_failure" | "runtime_infrastructure_failure"));
    if hard_fail { std::process::exit(1); }
    Ok(())
}
