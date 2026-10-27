//! 启动时读一次用户登录 shell 的环境（照 VS Code `getResolvedShellEnv` 的做法）。
//!
//! 从访达 / 程序坞 / 登录项打开的 Mesa 只有 launchd 给的最小环境：短 PATH、没有 LANG，
//! `.zshrc` / `.zprofile` 里配的 conda、Homebrew、版本管理器全都没有。之后起的 Agent 与后台命令
//! 用的 python3 / node 就和终端里不是同一个（2026-10-27 本机：安装版 python3 落到 Xcode 自带、
//! 没有 PyMuPDF，终端里是 conda；node 是 v26 而终端是 v22）。这里跑一次 `$SHELL -i -l -c`，
//! 把它的环境读回来写进本进程，之后所有子进程自然继承，与从终端启动的开发版一致。
//!
//! 凭据类变量不带（2026-10-27 用户拍板）：各家 API 密钥 / 端点由 Mesa 的连接配置在启动 Agent 时注入，
//! shell 里残留的不得混进来。必须在起任何线程之前调（set_var 不是线程安全的）。

use std::ffi::{OsStr, OsString};
use std::io::Read;
use std::os::unix::ffi::OsStrExt;
use std::time::{Duration, Instant};

/// 读 shell 环境最多等多久：挡着窗口出现，比 VS Code 的 10 秒短；本机实测约 0.36 秒
const RESOLVE_TIMEOUT: Duration = Duration::from_secs(5);

/// 读回来的环境里不带的变量（凭据、shell 自身与会话、Mesa 自管的、launchd 的）
fn should_import(key: &str) -> bool {
    const SECRET_SUFFIXES: &[&str] = &[
        "_API_KEY", "_KEY", "_TOKEN", "_SECRET", "_PASSWORD", "_PASSWD", "_CREDENTIALS",
    ];
    // 九家 Agent 的密钥 / 端点 / 模型变量都在这些前缀下（agent_specs 的注入表与官方账号净化表）
    const PROVIDER_PREFIXES: &[&str] = &[
        "ANTHROPIC_", "OPENAI_", "AZURE_OPENAI_", "GEMINI_", "GOOGLE_GEMINI_", "GOOGLE_API_",
        "CLAUDE_", "CODEX_", "KIMI_", "MOONSHOT_", "QWEN_", "DASHSCOPE_", "CODEBUDDY_", "CURSOR_",
        "XAI_", "GROK_", "OPENCODE_", "AWS_",
    ];
    const SHELL_AND_SESSION: &[&str] = &[
        "PWD", "OLDPWD", "SHLVL", "_", "FPATH", "PS1", "PS2", "PS3", "PS4", "RPROMPT", "RPS1",
        "COLORTERM", "NO_COLOR", "FORCE_COLOR", "SECURITYSESSIONID", "LaunchInstanceID",
    ];
    const OTHER_PREFIXES: &[&str] = &["PROMPT", "TERM", "CCODE_", "MESA_", "XPC_", "__CF"];
    let upper = key.to_ascii_uppercase();
    !(key.is_empty()
        || SECRET_SUFFIXES.iter().any(|s| upper.ends_with(s))
        || PROVIDER_PREFIXES.iter().any(|p| upper.starts_with(p))
        || SHELL_AND_SESSION.contains(&key)
        || OTHER_PREFIXES.iter().any(|p| key.starts_with(p)))
}

/// 取两个标记之间的 `env -0` 输出，按 NUL 切成 `KEY=VALUE`；rc 文件打到 stdout 的字在标记外，不影响
fn parse_env_dump(raw: &[u8], mark: &str) -> Option<Vec<(OsString, OsString)>> {
    let mark = mark.as_bytes();
    let find = |hay: &[u8]| hay.windows(mark.len()).position(|w| w == mark);
    let start = find(raw)? + mark.len();
    let len = find(&raw[start..])?;
    let body = &raw[start..start + len];
    Some(
        body.split(|b| *b == 0)
            .filter_map(|entry| {
                let eq = entry.iter().position(|b| *b == b'=')?;
                (eq > 0).then(|| {
                    (
                        OsStr::from_bytes(&entry[..eq]).to_os_string(),
                        OsStr::from_bytes(&entry[eq + 1..]).to_os_string(),
                    )
                })
            })
            .collect(),
    )
}

/// 各 shell 的参数：csh / tcsh 不认 `-l` 和 `-c` 分开写；nu / xonsh / pwsh 语法不同，不读
fn shell_args(shell: &str) -> Option<&'static [&'static str]> {
    let name = std::path::Path::new(shell).file_name()?.to_str()?;
    match name {
        "nu" | "xonsh" | "pwsh" | "pwsh-preview" | "powershell" => None,
        "csh" | "tcsh" => Some(&["-ic"]),
        _ => Some(&["-i", "-l", "-c"]),
    }
}

/// 跑一次登录 shell 并把环境写进本进程；从终端启动（已有 SHLVL）、读失败、超时都不改，
/// 只在应用日志里记一行（用时与变量个数，不记名字和值）
pub fn import_login_shell_env() {
    if std::env::var_os("SHLVL").is_some() {
        return;
    }
    let started = Instant::now();
    let note = match resolve() {
        Ok(env) => {
            let mut count = 0;
            for (key, value) in env {
                let Some(name) = key.to_str() else { continue };
                if should_import(name) && std::env::var_os(&key).as_deref() != Some(&value) {
                    std::env::set_var(&key, &value);
                    count += 1;
                }
            }
            format!("已读登录 shell 环境：{count} 个变量，用时 {} ms", started.elapsed().as_millis())
        }
        Err(e) => format!("没读到登录 shell 环境（{e}），用时 {} ms", started.elapsed().as_millis()),
    };
    crate::logbuf::record("info", "shell_env", &note);
}

fn resolve() -> Result<Vec<(OsString, OsString)>, String> {
    use std::os::unix::process::CommandExt;
    use std::process::Stdio;
    let shell = std::env::var("SHELL").ok().filter(|s| !s.is_empty()).ok_or("没有 SHELL")?;
    let args = shell_args(&shell).ok_or("shell 语法不支持")?;
    let mark = uuid::Uuid::new_v4().simple().to_string()[..12].to_string();
    let script = format!("printf '%s' {mark}; /usr/bin/env -0; printf '%s' {mark}");
    let mut child = crate::process::background_command(&shell)
        .args(args)
        .arg(&script)
        // 用户可在 rc 里据此跳过 tmux 自动挂载之类会卡住的操作（同 VSCODE_RESOLVING_ENVIRONMENT）
        .env("MESA_RESOLVING_ENVIRONMENT", "1")
        .current_dir(dirs::home_dir().unwrap_or_else(|| "/".into()))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .process_group(0)
        .spawn()
        .map_err(|e| format!("起 shell 失败：{e}"))?;
    let pid = child.id();
    let mut stdout = child.stdout.take().ok_or("没有输出管道")?;
    let (tx, rx) = std::sync::mpsc::channel();
    // rc 里起的后台进程可能一直占着管道写端：读线程等不到 EOF 就放着不管，它只读管道、不碰环境变量
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stdout.read_to_end(&mut buf);
        let _ = tx.send(buf);
    });
    let raw = match rx.recv_timeout(RESOLVE_TIMEOUT) {
        Ok(raw) => raw,
        Err(_) => {
            // 卡在 rc 里（等输入、自动挂 tmux 之类）：整个进程组收掉，回落现状
            crate::pty::kill_process_group(pid);
            let _ = child.wait();
            return Err(format!("超过 {} 秒", RESOLVE_TIMEOUT.as_secs()));
        }
    };
    let _ = child.wait();
    parse_env_dump(&raw, &mark).ok_or_else(|| "输出里没有环境".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_env_between_marks_and_ignores_rc_noise() {
        let raw = b"welcome!\nconda activated\nMARK123PATH=/opt/a:/usr/bin\0MULTI=line1\nline2\0EQ=a=b\0=bad\0MARK123trailing";
        let env = parse_env_dump(raw, "MARK123").unwrap();
        let get = |k: &str| env.iter().find(|(key, _)| key == k).map(|(_, v)| v.to_str().unwrap());
        assert_eq!(get("PATH"), Some("/opt/a:/usr/bin"));
        assert_eq!(get("MULTI"), Some("line1\nline2"));
        assert_eq!(get("EQ"), Some("a=b"));
        assert_eq!(env.len(), 3, "没有名字的条目丢掉");
        assert!(parse_env_dump(b"no marks here", "MARK123").is_none());
        assert!(parse_env_dump(b"MARK123 only one", "MARK123").is_none());
    }

    #[test]
    fn imports_tool_env_but_not_credentials_or_shell_internals() {
        for key in ["PATH", "LANG", "CONDA_PREFIX", "HOMEBREW_PREFIX", "https_proxy", "HTTPS_PROXY", "JAVA_HOME", "EDITOR"] {
            assert!(should_import(key), "{key} 应该带");
        }
        for key in [
            "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "OPENAI_BASE_URL", "GITHUB_TOKEN", "HF_TOKEN",
            "my_secret", "DB_PASSWORD", "AWS_ACCESS_KEY_ID", "GOOGLE_API_KEY", "MOONSHOT_API_KEY",
            "PWD", "SHLVL", "_", "FPATH", "PROMPT", "TERM", "TERM_PROGRAM", "NO_COLOR", "CCODE_CWD_FILE",
            "MESA_IMAGE_TOOL", "XPC_SERVICE_NAME", "__CF_USER_TEXT_ENCODING",
        ] {
            assert!(!should_import(key), "{key} 不该带");
        }
    }

    #[test]
    fn every_agent_credential_var_is_blocked() {
        // 官方账号净化表与启动注入表里的变量一个都不能从 shell 带进来
        let inject = [
            "ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_MODEL",
            "OPENAI_BASE_URL", "OPENAI_API_KEY", "OPENAI_MODEL", "GOOGLE_GEMINI_BASE_URL",
            "GEMINI_API_KEY", "GEMINI_MODEL", "CODEBUDDY_BASE_URL", "CODEBUDDY_API_KEY",
            "CODEBUDDY_MODEL", "GROK_MODELS_BASE_URL", "GROK_DEFAULT_MODEL", "XAI_API_KEY",
            "CODEX_API_KEY", "CURSOR_API_KEY", "OPENCODE_CONFIG_CONTENT", "KIMI_API_KEY",
        ];
        for key in inject {
            assert!(!should_import(key), "{key} 不该带");
        }
        for spec in crate::agent_specs::all_agent_specs() {
            if let Some(oa) = &spec.official_account {
                for key in oa.env_purge_list {
                    assert!(!should_import(key), "{} 的 {key} 不该带", spec.id);
                }
            }
        }
    }

    #[test]
    fn shell_args_by_dialect() {
        assert_eq!(shell_args("/bin/zsh"), Some(&["-i", "-l", "-c"][..]));
        assert_eq!(shell_args("/opt/homebrew/bin/fish"), Some(&["-i", "-l", "-c"][..]));
        assert_eq!(shell_args("/bin/tcsh"), Some(&["-ic"][..]));
        assert_eq!(shell_args("/opt/homebrew/bin/nu"), None);
        assert_eq!(shell_args("/usr/local/bin/pwsh"), None);
    }
}
