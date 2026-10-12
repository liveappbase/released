#!/usr/bin/env bash
# liveapp-guard-version: 6
#
# liveapp-push-guard.sh — the Live App Contract's PreToolUse hook, shipped by the engine and
# installed/version-migrated into an adopted app's .claude/hooks/ by the `agent_hooks` bootstrap.
#
# THIS HOOK READS NO COMMAND TEXT. Versions 1-4 re-derived push/commit targets from command
# STRINGS; four review rounds found bypass after bypass (compound commands, ssh/https remotes,
# HEAD/@, +force markers, refs/heads/ forms, words inside -m messages) — a shell/git string matcher
# cannot be simultaneously complete (never miss the default branch) and loop-safe (never block
# feature work). v5 moved the PUSH decision to the git-native hooks, which git hands exact resolved
# refs, and said in this header that it parsed no commands — but it kept one string matcher, for
# self-protection, and that matcher cost the same way the first four did. v6 deletes it. The hook
# no longer extracts `tool_input.command` at all, so the claim is structural rather than stated.
#
# WHY, MEASURED (2026-10-07, engine-ts/test/repo/push-guard.test.ts). The v5 self-protection
# matcher fired when `>` (or rm/cp/mv/tee/dd/install/truncate/`sed -i`) appeared ANYWHERE in the
# text — `2>&1` and `2>/dev/null` included — beside a path-shaped token:
#   * it DENIED 3 of 8 read-only commands: a `git diff` of a hook redirected to a scratch file, a
#     `wc -c` with stderr silenced, a shell variable that merely HELD the path. In one session it
#     also refused two commits whose MESSAGE named a hook, a code comment, and the command written
#     to measure it. A guard people route around protects nothing, and this one taught evasion.
#   * it CAUGHT 2 of 11 real mutations. It missed `chmod -x` (which disables this hook outright),
#     `git checkout HEAD~N --` (which restores a weaker version), perl -pi, python open(w), ed,
#     patch(1), git apply, ln -sf, and any path held in a variable.
# So it was 38% false on reads and 18% effective on writes. Deleting it loses almost nothing real,
# because the protection that matters is elsewhere and is STRUCTURAL:
#   * this hook's own Edit/Write/MultiEdit/NotebookEdit branch below, which reads
#     `tool_input.file_path` — a field the HOST resolved, not a string this hook re-parsed;
#   * the GIT-NATIVE pre-push/pre-commit gates, which git hands the exact refs;
#   * server-side branch protection, where the plan allows one;
#   * and this hook's own failure mode: neutralise it and NO approval token is minted, so the
#     git-native gates refuse. Disabling the guard FAILS CLOSED — it blocks the pusher.
#
# This hook keeps exactly two jobs:
#   1. TOKEN MINTING — on each Bash call, read the session's LAST USER MESSAGE (transcript); if
#      it carries an approval phrase ("ship it" / "push" / "land it" / "commit", not negated),
#      mint the short-TTL ONE-SHOT approval token at
#      $(git rev-parse --git-common-dir)/liveapp-approve for the session cwd's repo. The
#      git-native hooks honor and consume it. Command text is never consulted.
#   2. SELF-PROTECTION, STRUCTURED ONLY — deny Edit/Write of this guard, the git-native hooks
#      (installed names, template names, and .liveapp-chained originals), and the hook config,
#      judged on the host-resolved `file_path` and nothing else.
# Everything else is ALLOW — a matcher miss can no longer be a bypass, because the matcher no
# longer decides.
#
# Hook I/O (Claude Code): stdin JSON has .tool_name, .tool_input.file_path (Edit/Write), .cwd, and
# .transcript_path. `.tool_input.command` IS DELIBERATELY NOT READ. DENY = print
# {"hookSpecificOutput":{...,"deny",...}} + exit 0. ALLOW = print nothing + exit 0 (defer to
# normal flow).
#
# LIVEAPP_* it reads (real path first; the rest are test/override hooks):
#   transcript_path (JSON)   the live transcript — last user message is read for the approval phrase
#   LIVEAPP_LAST_USER_MSG    override the last user message — skips transcript parsing (tests)
#   LIVEAPP_GUARD_SELF       absolute path of this guard's live copy (self-protection)
set -uo pipefail
set -f          # defensive: no globbing. No unquoted expansion remains, and none should return.

# ---- parse the hook JSON (node preferred, python3 fallback; base64 fields so a field with
# tabs/newlines/quotes can't corrupt the split) ----
RAW="$(cat)"
parsed=""
if command -v node >/dev/null 2>&1; then
  parsed="$(printf '%s' "$RAW" | node -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
      try{const j=JSON.parse(s);const b=x=>Buffer.from(String(x==null?"":x)).toString("base64");
        const ti=j.tool_input||{};
        process.stdout.write([j.tool_name||"",b(ti.file_path),b(ti.notebook_path),b(j.cwd),b(j.transcript_path)].join("\t"));
      }catch(e){process.exit(7)}});' 2>/dev/null)"
fi
if [ -z "$parsed" ] && command -v python3 >/dev/null 2>&1; then
  parsed="$(printf '%s' "$RAW" | python3 -c '
import sys,json,base64
try:
  j=json.load(sys.stdin); ti=j.get("tool_input",{}) or {}
  b=lambda x: base64.b64encode(str(x if x is not None else "").encode()).decode()
  print("\t".join([j.get("tool_name","") or "", b(ti.get("file_path")), b(ti.get("notebook_path")), b(j.get("cwd","")), b(j.get("transcript_path",""))]))
except Exception:
  sys.exit(7)' 2>/dev/null)"
fi

deny() {
  # control chars (a newline-y file path, say) would break the JSON — flatten them first
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":%s}}\n' \
    "$(printf '%s' "$1" | tr '\000-\037' ' ' | sed 's/\\/\\\\/g; s/"/\\"/g; s/^/"/; s/$/"/')"
  exit 0
}

# Could not parse -> ALLOW (defer to normal flow). A malformed payload is not something this hook
# could have judged anyway, and a blanket deny would brick every tool call.
[ -z "$parsed" ] && exit 0

TOOL="${parsed%%	*}"
rest="${parsed#*	}"
PATH_B64="${rest%%	*}"; rest="${rest#*	}"
NB_B64="${rest%%	*}"; rest="${rest#*	}"
CWD_B64="${rest%%	*}"; TRANSCRIPT_B64="${rest#*	}"
b64d() { printf '%s' "$1" | { base64 -d 2>/dev/null || base64 -D 2>/dev/null; }; }
# BOTH PATH FIELDS, SEPARATELY. Round 2 read `file_path || notebook_path`, i.e. the first NON-EMPTY
# of the two — so a payload carrying a benign `file_path` AND a protected `notebook_path` was
# ALLOWED (measured). Not reachable with today's NotebookEdit schema, which carries only
# `notebook_path`, but it is a precedence hazard round 2 introduced while closing the empty-path
# bug, and "the first field wins" is never the right rule for a refusal.
FPATH="$(b64d "$PATH_B64")"
NBPATH="$(b64d "$NB_B64")"
HCWD="$(b64d "$CWD_B64")"
TRANSCRIPT="$(b64d "$TRANSCRIPT_B64")"

# ---- self-protection: this guard, the GIT-NATIVE gates, and anything that controls hooks ----
is_protected_path() {
  # COLLAPSE `//` FIRST: `.githooks//pre-push` is the same inode on every filesystem (POSIX folds
  # it), and the glob below could not match it. Measured with `stat -f %i`.
  set -- "$(printf '%s' "$1" | sed 's|//*|/|g')"
  case "$1" in
    # THE APPROVAL TOKEN ITSELF. `token_ok` in liveapp-pre-push.sh accepts any fresh integer with no
    # provenance on it, so one Write of this file approves a push to the default branch — the single
    # invariant the whole three-layer design exists to hold. Protecting the gates and not the thing
    # that opens them left the lock on the door and the key under the mat.
    */liveapp-approve) return 0;;
    # the SETTING that decides whether git runs the gates at all. Repoint core.hooksPath and every
    # gate is inert, so protecting the gate files and not this was a door standing open.
    */.git/config|*/.git/config.worktree) return 0;;
    # any hook ENTRY POINT by name, not only a path containing `hooks/`: husky uses `.husky/pre-push`
    # and lefthook `.lefthook/pre-push`, and the engine installs into whatever core.hooksPath names,
    # so the file git actually executes was the one left open.
    */pre-push|*/pre-commit) return 0;;
    *"/.claude/hooks/"*|*"/.claude/settings.json"|*"/.claude/settings.local.json") return 0;;
    */liveapp-push-guard.sh|*/liveapp-pre-push.sh|*/liveapp-pre-commit.sh) return 0;;
    *hooks/pre-push|*hooks/pre-commit|*.liveapp-chained) return 0;;
  esac
  [ -n "${LIVEAPP_GUARD_SELF:-}" ] && [ "$1" = "$LIVEAPP_GUARD_SELF" ] && return 0
  return 1
}
case "$TOOL" in
  Edit|Write|NotebookEdit|MultiEdit)
    for p in "$FPATH" "$NBPATH"; do
      [ -n "$p" ] || continue
      is_protected_path "$p" && deny "refusing to let an edit modify the push guard / git-native gates / hook config ($p)"
    done
    exit 0 ;;
  Bash) : ;;
  *)    exit 0 ;;
esac

# ---- token minting: the last USER message is the approval, never the command ----
LAST="${LIVEAPP_LAST_USER_MSG:-}"
if [ -z "$LAST" ] && [ -n "$TRANSCRIPT" ] && [ -f "$TRANSCRIPT" ] && command -v jq >/dev/null 2>&1; then
  LAST=$(jq -rs '
    [.[]? | select((.type // "") == "user")
     # PROVENANCE. `type:"user"` is NOT "a human said this": Claude Code writes a subagent prompt
     # (authored by the assistant) and injected skill/command bodies as user records too. Measured:
     # the filter selected an isMeta+isSidechain record carrying "ship it". Reject those, and reject
     # a content array holding a tool_result — tool output is not an utterance.
     | select((.isMeta // false) == false)
     | select((.isSidechain // false) == false)
     | . as $m | (try $m.message.content catch null) as $c
     | select($c != null and (($c|type)=="string" or (($c|type)=="array" and ($c|any((.type? // "")=="text")) and (($c|any((.type? // "")=="tool_result"))|not))))]
    | last | .message.content
    | if type=="string" then . else (map(select((.type? // "")=="text")|(.text? // ""))|join(" ")) end
  ' "$TRANSCRIPT" 2>/dev/null || echo "")
fi
NORM=$(printf '%s' "$LAST" | tr '\n' ' ')

# union of the old commit+push phrase lists — one token serves both git-native gates
APPROVE_RE='(^|[[:space:]])(commit|amend|ok commit|push|push it|ok push|ship it|land it|go ahead and (commit|push|amend))([[:space:][:punct:]]|$)'
# UNBOUNDED WITHIN THE SENTENCE. This was `[^.]{0,40}`, so
#   "do not, under any circumstances whatsoever at all, push to main"
# read as APPROVAL (measured). Erring the other way only ever FAILS TO MINT, which refuses a push —
# the safe direction.
NEGATE_RE="(don'?t|do not|never|wait|please not)[^.]*(commit|amend|push|ship it|land it)"

if [ -n "$NORM" ] && grep -qiE "$APPROVE_RE" <<<"$NORM" && ! grep -qiE "$NEGATE_RE" <<<"$NORM"; then
  gd="$( cd "$HCWD" 2>/dev/null && git rev-parse --git-common-dir 2>/dev/null )"
  if [ -n "${gd:-}" ]; then
    case "$gd" in /*) : ;; *) gd="$HCWD/$gd" ;; esac
    [ -d "$gd" ] && date +%s > "$gd/liveapp-approve" 2>/dev/null
  fi
fi
exit 0
