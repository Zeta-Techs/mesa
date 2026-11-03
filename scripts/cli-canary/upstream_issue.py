"""金丝雀「上游通道雷达」的提醒：有新线索时开一条 issue，之后的新线索追加成评论；同一条（按键）只提醒一次。

只在 CI（.github/workflows/cli-canary.yml，macOS 那一路）调：python3 scripts/cli-canary/upstream_issue.py <upstream-new.md>
需要 gh 已登录（工作流里用 GH_TOKEN = github.token，权限 issues: write）。
看完线索后的处理见 scripts/cli-canary/README.md「上游通道雷达」：在 upstream.json 写结论，要接的照 Kimi 程序状态那次做。
"""
import json, os, re, subprocess, sys

TITLE = "上游有新的结构化通道：聊天层可以更接近上游"
KEYS = re.compile(r"<!-- upstream-keys: ([^>]*) -->")


def gh(*args):
    return subprocess.run(["gh", *args], capture_output=True, text=True, encoding="utf-8", check=True).stdout


def keys_in(text):
    out = set()
    for m in KEYS.finditer(text or ""):
        out.update(k for k in m.group(1).split(",") if k)
    return out


def main():
    body = open(sys.argv[1], encoding="utf-8").read()
    want = keys_in(body)
    if not want:
        return
    run = os.environ.get("GITHUB_RUN_ID")
    if run:
        body += f"\n\n来自金丝雀运行：{os.environ.get('GITHUB_SERVER_URL')}/{os.environ.get('GITHUB_REPOSITORY')}/actions/runs/{run}\n"
    found = json.loads(gh("issue", "list", "--state", "open", "--search", f"in:title {TITLE}", "--json", "number,title,body"))
    issue = next((i for i in found if i["title"] == TITLE), None)
    if issue is None:
        gh("issue", "create", "--title", TITLE, "--body", body)
        print("开了新 issue")
        return
    seen = keys_in(issue.get("body"))
    for c in json.loads(gh("issue", "view", str(issue["number"]), "--json", "comments"))["comments"]:
        seen |= keys_in(c.get("body"))
    if want <= seen:
        print("都提醒过了")
        return
    gh("issue", "comment", str(issue["number"]), "--body", body)
    print(f"追加到 #{issue['number']}：{sorted(want - seen)}")


if __name__ == "__main__":
    main()
