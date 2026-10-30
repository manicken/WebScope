//! Port of settings.js - the backend's settings: the defaults, then settings.json (when it exists), then the
//! command line. The same settings.json as the Node backend:
//!   { "port": 8080, "open": false, "allowOrigins": [...], "allowHosts": [...], "hostCheck": true, "allowDelete": true,
//!     "sigrokCli": "...", "logicAnalyzerHosts": ["192.168.1.20:4045"] }      every key optional
//! Command line (wins over settings.json; the lists add to the ones in settings.json):
//!   --port <n>  --open  --allow-origin <origin>  --allow-host <name>  --no-host-check  --no-delete  --settings <file>
//!   --allow-admin   run as root/administrator (refused otherwise); command line only, not in settings.json
//! The access checks (is_host_allowed / is_origin_allowed) are here too, as they only depend on the settings.

use serde_json::Value;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug)]
pub struct Settings {
    pub port: u16,
    pub open: bool,
    pub allow_origins: Vec<String>,
    pub allow_hosts: Vec<String>,
    pub host_check: bool,
    /// false: the file API cannot delete (still create, write, move)
    pub allow_delete: bool,
    pub sigrok_cli: Option<String>,
    pub logic_analyzer_hosts: Vec<String>,
    /// --allow-admin: command line only
    pub allow_admin: bool,
    /// the settings.json that was read
    pub file: Option<PathBuf>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            port: 8080,
            open: false,
            allow_origins: Vec::new(),
            allow_hosts: Vec::new(),
            host_check: true,
            allow_delete: true,
            sigrok_cli: None,
            logic_analyzer_hosts: Vec::new(),
            allow_admin: false,
            file: None,
        }
    }
}

const KNOWN: [&str; 8] = ["port", "open", "allowOrigins", "allowHosts", "hostCheck", "allowDelete", "sigrokCli", "logicAnalyzerHosts"];

fn strings(v: &Value) -> Option<Vec<String>> {
    v.as_array()?.iter().map(|s| s.as_str().map(String::from)).collect()
}

/// Apply the contents of a settings.json (as JSON) to settings.
pub fn apply_settings_json(s: &mut Settings, json: &Value, file: &str) -> Result<(), String> {
    let Some(obj) = json.as_object() else {
        return Err(format!("{file}: must be a JSON object"));
    };
    for (key, value) in obj {
        let wrong = |t: &str| format!("{file}: \"{key}\" must be a {t}");
        match key.as_str() {
            "port" => {
                let n = value.as_f64().ok_or_else(|| wrong("number"))?;
                s.port = if n.fract() == 0.0 && (1.0..=65535.0).contains(&n) { n as u16 } else { return Err("Invalid port number".into()) };
            }
            "open" => s.open = value.as_bool().ok_or_else(|| wrong("boolean"))?,
            "hostCheck" => s.host_check = value.as_bool().ok_or_else(|| wrong("boolean"))?,
            "allowDelete" => s.allow_delete = value.as_bool().ok_or_else(|| wrong("boolean"))?,
            "allowOrigins" => s.allow_origins = strings(value).ok_or_else(|| wrong("string[]"))?,
            "allowHosts" => s.allow_hosts = strings(value).ok_or_else(|| wrong("string[]"))?,
            "logicAnalyzerHosts" => s.logic_analyzer_hosts = strings(value).ok_or_else(|| wrong("string[]"))?,
            "sigrokCli" => s.sigrok_cli = Some(value.as_str().ok_or_else(|| wrong("string"))?.to_string()),
            _ => eprintln!("{file}: unknown setting \"{key}\" ignored (known: {})", KNOWN.join(", ")),
        }
    }
    Ok(())
}

/// Apply the command line arguments to settings.
pub fn apply_args(s: &mut Settings, args: &[String]) -> Result<(), String> {
    let mut i = 0;
    while i < args.len() {
        let value = |i: usize| args.get(i + 1).cloned().ok_or_else(|| format!("{} needs a value", args[i]));
        match args[i].as_str() {
            "--port" => {
                s.port = value(i)?.parse().ok().filter(|&p| p > 0).ok_or("Invalid port number")?;
                i += 1;
            }
            "--open" => s.open = true,
            "--allow-origin" => {
                s.allow_origins.push(value(i)?);
                i += 1;
            }
            "--allow-host" => {
                s.allow_hosts.push(value(i)?);
                i += 1;
            }
            "--no-host-check" => s.host_check = false,
            "--no-delete" => s.allow_delete = false,
            "--allow-admin" => s.allow_admin = true,
            "--settings" => i += 1, // read by load_settings()
            other => eprintln!("unknown argument {other} ignored"),
        }
        i += 1;
    }
    Ok(())
}

/// The defaults, `default_file` (or --settings <file>) when it exists, then the command line.
pub fn load_settings(args: &[String], default_file: Option<&Path>, base: Settings) -> Result<Settings, String> {
    let given = args.iter().position(|a| a == "--settings");
    let file: Option<PathBuf> = match given {
        Some(i) => Some(PathBuf::from(args.get(i + 1).ok_or("--settings needs a value")?)),
        None => default_file.map(Path::to_path_buf),
    };
    let mut s = base;
    match &file {
        Some(f) if f.exists() => {
            let name = f.display().to_string();
            let text = fs::read_to_string(f).map_err(|e| format!("{name}: {e}"))?;
            let json: Value = serde_json::from_str(&text).map_err(|e| format!("{name}: {e}"))?;
            apply_settings_json(&mut s, &json, &name)?;
            s.file = Some(f.clone());
        }
        Some(f) if given.is_some() => return Err(format!("settings file not found: {}", f.display())),
        _ => {}
    }
    apply_args(&mut s, args)?;
    Ok(s)
}

/* ============================== access checks ============================== */

/// "example.com:8080" -> "example.com", "[::1]:8080" -> "::1" (lower case), None when it is not a host.
pub fn hostname(host: &str) -> Option<String> {
    static RES: std::sync::OnceLock<[regex_lite::Regex; 2]> = std::sync::OnceLock::new();
    let [ipv6, name] = RES.get_or_init(|| {
        [r"^\[([^\]]+)\](?::\d+)?$", r"^([^:\[\]]+)(?::\d+)?$"].map(|r| regex_lite::Regex::new(r).unwrap())
    });
    let m = ipv6.captures(host).or_else(|| name.captures(host))?;
    Some(m[1].to_lowercase())
}

/// This computer's name (as Node's os.hostname()).
fn computer_name() -> Option<String> {
    for var in ["COMPUTERNAME", "HOSTNAME"] {
        if let Ok(n) = std::env::var(var) {
            if !n.is_empty() {
                return Some(n);
            }
        }
    }
    fs::read_to_string("/proc/sys/kernel/hostname").or_else(|_| fs::read_to_string("/etc/hostname")).ok().map(|s| s.trim().to_string())
}

/// The names this computer is reached by: loopback, its own name, the addresses of its network interfaces.
pub fn local_hostnames() -> HashSet<String> {
    let mut names: HashSet<String> = ["localhost", "127.0.0.1", "::1"].map(String::from).into();
    if let Some(n) = computer_name() {
        let n = n.to_lowercase();
        names.insert(format!("{n}.local"));
        names.insert(n);
    }
    if let Ok(list) = if_addrs::get_if_addrs() {
        for a in list {
            names.insert(a.ip().to_string().to_lowercase());
        }
    }
    names
}

/// Is the request for this computer? The Host header is the name the browser used to reach the backend: a page
/// that rebinds its own DNS name to this computer (DNS rebinding) still sends that name, and is refused here.
pub fn is_host_allowed(host: Option<&str>, s: &Settings, local: &HashSet<String>) -> bool {
    if !s.host_check {
        return true;
    }
    let Some(host) = host else { return true }; // not a browser: browsers always send Host
    let Some(name) = hostname(host) else { return false };
    name.ends_with(".localhost") || local.contains(&name) || s.allow_hosts.iter().any(|h| h.to_lowercase() == name)
}

/// The `host` of an origin as JavaScript's URL has it: "http://LocalHost:80" -> "localhost".
fn origin_host(origin: &str) -> Option<String> {
    let (scheme, rest) = origin.split_once("://")?;
    let authority = rest.split(['/', '?', '#']).next()?.to_lowercase();
    let authority = authority.rsplit_once('@').map_or(authority.as_str(), |(_, a)| a).to_string();
    let default = match scheme.to_lowercase().as_str() {
        "http" | "ws" => ":80",
        "https" | "wss" => ":443",
        _ => "",
    };
    Some(if !default.is_empty() && authority.ends_with(default) { authority[..authority.len() - default.len()].to_string() } else { authority })
}

/// May the page that sent the request use this backend? Pages served by this backend itself and non-browser
/// clients (no Origin header) may, other pages only when their origin is in allowOrigins ("*" = any page).
/// Only safe together with is_host_allowed(): without it a rebound page passes the same-host test.
pub fn is_origin_allowed(origin: Option<&str>, host: Option<&str>, s: &Settings) -> bool {
    let Some(origin) = origin else { return true };
    if s.allow_origins.iter().any(|o| o == "*" || o == origin) {
        return true;
    }
    matches!((origin_host(origin), host), (Some(o), Some(h)) if o == h)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn settings_json_and_args() {
        let mut s = Settings::default();
        apply_settings_json(&mut s, &json!({ "port": 9000, "allowHosts": ["scope.lan"], "hostCheck": false }), "f").unwrap();
        assert_eq!((s.port, s.allow_hosts.clone(), s.host_check), (9000, vec!["scope.lan".to_string()], false));
        assert!(apply_settings_json(&mut Settings::default(), &json!({ "port": "9000" }), "f").unwrap_err().contains("port"));
        assert!(apply_settings_json(&mut Settings::default(), &json!({ "allowHosts": "x" }), "f").unwrap_err().contains("allowHosts"));
        assert!(apply_settings_json(&mut Settings::default(), &json!([1]), "f").unwrap_err().contains("object"));

        let mut s = Settings::default();
        apply_settings_json(&mut s, &json!({ "port": 9000, "allowOrigins": ["https://a.example"] }), "f").unwrap();
        let args: Vec<String> = ["--port", "8081", "--open", "--allow-origin", "https://b.example", "--no-host-check", "--settings", "x.json", "--allow-admin", "--no-delete"]
            .map(String::from).to_vec();
        apply_args(&mut s, &args).unwrap();
        assert_eq!((s.port, s.open, s.host_check, s.allow_admin, s.allow_delete), (8081, true, false, true, false));
        assert_eq!(s.allow_origins, vec!["https://a.example", "https://b.example"]);
        assert!(apply_args(&mut Settings::default(), &["--allow-host".to_string()]).unwrap_err().contains("needs a value"));
    }

    #[test]
    fn hostnames() {
        assert_eq!(hostname("Example.com:8080").as_deref(), Some("example.com"));
        assert_eq!(hostname("192.168.1.50").as_deref(), Some("192.168.1.50"));
        assert_eq!(hostname("[::1]:8080").as_deref(), Some("::1"));
        assert_eq!(hostname("a:b:c"), None);
    }

    #[test]
    fn host_check() {
        let s = Settings::default();
        let local = local_hostnames();
        for host in ["localhost:8080", "127.0.0.1:8080", "[::1]:8080", "scope.localhost:8080"] {
            assert!(is_host_allowed(Some(host), &s, &local), "{host}");
        }
        if let Some(n) = computer_name() {
            assert!(is_host_allowed(Some(&format!("{n}:8080")), &s, &local));
        }
        assert!(is_host_allowed(None, &s, &local));
        assert!(!is_host_allowed(Some("evil.example:8080"), &s, &local));
        let lan = Settings { allow_hosts: vec!["scope.lan".into()], ..Settings::default() };
        assert!(is_host_allowed(Some("Scope.Lan:8080"), &lan, &local));
        let off = Settings { host_check: false, ..Settings::default() };
        assert!(is_host_allowed(Some("evil.example:8080"), &off, &local));
    }

    #[test]
    fn origin_check() {
        let s = Settings::default();
        let h = Some("localhost:8080");
        assert!(is_origin_allowed(None, h, &s));
        assert!(is_origin_allowed(Some("http://localhost:8080"), h, &s));
        assert!(!is_origin_allowed(Some("https://other.example"), h, &s));
        let listed = Settings { allow_origins: vec!["https://other.example".into()], ..Settings::default() };
        assert!(is_origin_allowed(Some("https://other.example"), h, &listed));
        let any = Settings { allow_origins: vec!["*".into()], ..Settings::default() };
        assert!(is_origin_allowed(Some("https://other.example"), h, &any));
        assert!(is_origin_allowed(Some("http://localhost"), Some("localhost"), &s));
    }
}
