#!/usr/bin/env bash
#
# Phase 5 evidence: the Android hardware back-button matrix.
#
# Drives the real handset — the installed APK's own WebView over CDP for state,
# and real `KEYCODE_BACK` events through adb. Nothing is simulated.
#
# The chain under test is `drawer -> sheet -> home -> double-tap exit`, in that
# order, per ENGINEERING_EXECUTION_SPEC Phase 5.
#
# WHY BASH AND NOT NODE: on this host a Node process cannot spawn `adb` at all
# (`spawnSync adb EBUSY`, even for `adb version`, and even with the sandbox
# disabled) — child-process spawns of executables outside the workspace are
# blocked. Bash can. So bash orchestrates and Node is used only for CDP, which
# needs no child process.
#
# Usage:
#   tools/probe-native-back.sh
#   ANDROID_SERIAL=XXXX CDP_PORT=9224 tools/probe-native-back.sh
#
# Prerequisites: the debug APK is installed, and
#   adb forward tcp:$CDP_PORT localabstract:webview_devtools_remote_$(adb shell pidof app.flowie)
#
# The last scenario EXITS THE APP by design, so it runs last.

set -uo pipefail

SERIAL="${ANDROID_SERIAL:-R5CX2328T5A}"
export CDP_PORT="${CDP_PORT:-9224}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

adb() { command adb -s "$SERIAL" "$@"; }

PASS=0
FAIL=0
declare -a RESULTS

record() { # record <name> <0|1> <detail>
  if [ "$2" = "1" ]; then
    PASS=$((PASS + 1)); printf 'PASS  %s\n      %s\n' "$1" "$3"
  else
    FAIL=$((FAIL + 1)); printf 'FAIL  %s\n      %s\n' "$1" "$3"
  fi
  RESULTS+=("{\"name\":\"$1\",\"pass\":$([ "$2" = "1" ] && echo true || echo false),\"detail\":$3}")
}

# --- CDP helpers -----------------------------------------------------------

# Prints a compact pipe-delimited state string: drawer|sheet|tab|toast
read_state() {
  node "$ROOT/tools/cdp-eval.mjs" localhost \
    '(function(){var a=document.querySelector("[data-tab]:not([hidden])");var t=document.querySelector(".glass");return [document.querySelector("[aria-label=\"Close menu\"]")?"1":"0",document.querySelector("[aria-label=\"Close sheet\"]")?"1":"0",a?a.getAttribute("data-tab"):"none",t?(t.textContent||"").replace(/\|/g,"/").trim().slice(0,60):""].join("|");})()' \
    2>/dev/null | tr -d '"'
}

state_json() { # turn the pipe string into JSON
  local raw="$1"
  local drawer sheet tab toast
  drawer="$(echo "$raw" | cut -d'|' -f1)"
  sheet="$(echo "$raw" | cut -d'|' -f2)"
  tab="$(echo "$raw" | cut -d'|' -f3)"
  toast="$(echo "$raw" | cut -d'|' -f4-)"
  printf '{"drawer":%s,"sheet":%s,"tab":"%s","toast":"%s"}' \
    "$([ "$drawer" = "1" ] && echo true || echo false)" \
    "$([ "$sheet" = "1" ] && echo true || echo false)" \
    "$tab" "$toast"
}

# Click the first button whose text or aria-label matches (case-insensitive).
click_by() {
  local pattern="$1"
  node "$ROOT/tools/cdp-eval.mjs" localhost \
    "(function(){var re=new RegExp(\"$pattern\",\"i\");var els=Array.from(document.querySelectorAll(\"button,[role=button],a[href]\"));var t=els.find(function(e){return re.test(e.textContent||\"\")||re.test(e.getAttribute(\"aria-label\")||\"\")});if(!t)return \"NOTFOUND\";t.click();return \"CLICKED\";})()" \
    2>/dev/null | tr -d '"'
}

has_shell() {
  node "$ROOT/tools/cdp-eval.mjs" localhost \
    '(function(){return !!document.querySelector("[data-tab]");})()' \
    2>/dev/null | tr -d '"'
}

back() { adb shell input keyevent KEYCODE_BACK >/dev/null 2>&1; sleep 1; }

# The package/activity currently on top, e.g. `app.flowie/.MainActivity`.
foreground_activity() {
  adb shell dumpsys activity activities 2>/dev/null \
    | grep -m1 -i "topResumedActivity" \
    | grep -oE '[A-Za-z0-9_.]+/[A-Za-z0-9_.]+' \
    | head -1
}

# --- run -------------------------------------------------------------------

echo
echo "Back-button matrix — device $SERIAL, CDP :$CDP_PORT"
echo

# The mock/demo session is in-memory, not persisted: a force-stop lands the app
# back on the auth screen. Sign in first, or every scenario below measures the
# wrong screen and fails for the wrong reason.
SHELL_UP=0
for _ in $(seq 1 15); do
  if [ "$(has_shell)" = "true" ]; then SHELL_UP=1; break; fi
  click_by "skip auth" >/dev/null
  sleep 2.5
done
record "reached the app shell (demo sign-in)" "$SHELL_UP" '{}'
if [ "$SHELL_UP" != "1" ]; then
  echo
  echo "Could not reach the shell — aborting before the matrix."
  exit 1
fi

# Baseline: on Today with nothing open, or the scenarios measure the wrong state.
RAW="$(read_state)"
D="$(echo "$RAW" | cut -d'|' -f1)"; S="$(echo "$RAW" | cut -d'|' -f2)"; T="$(echo "$RAW" | cut -d'|' -f3)"
record "baseline: Today tab, nothing open" \
  "$([ "$D" = "0" ] && [ "$S" = "0" ] && [ "$T" = "home" ] && echo 1 || echo 0)" \
  "$(state_json "$RAW")"

# --- 1. drawer -------------------------------------------------------------
R="$(click_by '^Open settings$')"
sleep 1
RAW="$(read_state)"
D="$(echo "$RAW" | cut -d'|' -f1)"
record "drawer opens from the settings button" \
  "$([ "$R" = "CLICKED" ] && [ "$D" = "1" ] && echo 1 || echo 0)" \
  "$(state_json "$RAW")"

back
RAW="$(read_state)"
D="$(echo "$RAW" | cut -d'|' -f1)"
record "BACK closes the drawer" "$([ "$D" = "0" ] && echo 1 || echo 0)" "$(state_json "$RAW")"

# --- 2. sheet --------------------------------------------------------------
# Home's location chip opens the "Weather location" sheet. Match its aria-label,
# not the city name: the city also appears in the weather card, so a text match
# picks the wrong element and the sheet never opens.
R="$(click_by '^Change weather location$')"
sleep 1.2
RAW="$(read_state)"
S="$(echo "$RAW" | cut -d'|' -f2)"
record "sheet opens from the location chip" \
  "$([ "$S" = "1" ] && echo 1 || echo 0)" \
  "$(state_json "$RAW")"

if [ "$S" = "1" ]; then
  back
  RAW="$(read_state)"
  S="$(echo "$RAW" | cut -d'|' -f2)"
  record "BACK closes the sheet" "$([ "$S" = "0" ] && echo 1 || echo 0)" "$(state_json "$RAW")"
fi

# --- 3. tab ----------------------------------------------------------------
R="$(click_by '^Closet$')"
sleep 1.2
RAW="$(read_state)"
T="$(echo "$RAW" | cut -d'|' -f3)"
record "switched to the Closet tab" "$([ "$T" = "closet" ] && echo 1 || echo 0)" "$(state_json "$RAW")"

if [ "$T" = "closet" ]; then
  back
  RAW="$(read_state)"
  T="$(echo "$RAW" | cut -d'|' -f3)"
  record "BACK returns to Today" "$([ "$T" = "home" ] && echo 1 || echo 0)" "$(state_json "$RAW")"
fi

# --- 4. double-tap exit (LAST — this really exits) -------------------------
RAW="$(read_state)"
D="$(echo "$RAW" | cut -d'|' -f1)"; S="$(echo "$RAW" | cut -d'|' -f2)"; T="$(echo "$RAW" | cut -d'|' -f3)"
record "baseline for exit: Today, nothing open" \
  "$([ "$D" = "0" ] && [ "$S" = "0" ] && [ "$T" = "home" ] && echo 1 || echo 0)" \
  "$(state_json "$RAW")"

back
RAW="$(read_state)"
TOAST="$(echo "$RAW" | cut -d'|' -f4-)"
record "first BACK warns instead of exiting" \
  "$(echo "$TOAST" | grep -qi 'press back again' && echo 1 || echo 0)" \
  "$(state_json "$RAW")"

# The exit is a genuine double-tap: the two presses must land inside the app's
# 2s window. Reading state costs a Node+CDP round-trip, so it must NOT sit
# between them — an earlier version of this probe did that, the window expired,
# and a working app was reported as a failure. Wait out the window from the
# warning press first, then fire the pair back to back.
sleep 2.5
FG_BEFORE="$(foreground_activity)"
back
back
sleep 1.5
FG_AFTER="$(foreground_activity)"
# Assert on the FOREGROUND ACTIVITY, not `pidof`. Capacitor's exitApp() calls
# finishAffinity(), which closes the activity while Android keeps the process
# cached — so a pid check reports a working exit as a failure.
record "double-tap BACK exits to the launcher" \
  "$(echo "$FG_AFTER" | grep -q 'app.flowie' && echo 0 || echo 1)" \
  "{\"foregroundBefore\":\"$FG_BEFORE\",\"foregroundAfter\":\"$FG_AFTER\"}"

# --- summary ---------------------------------------------------------------
echo
echo "$PASS/$((PASS + FAIL)) passed"
if [ "$FAIL" != "0" ]; then echo "FAILURES: $FAIL"; fi

{
  printf '{\n  "device": "%s",\n  "passed": %d,\n  "failed": %d,\n  "results": [\n' \
    "$SERIAL" "$PASS" "$FAIL"
  for i in "${!RESULTS[@]}"; do
    printf '    %s' "${RESULTS[$i]}"
    [ "$i" -lt "$((${#RESULTS[@]} - 1))" ] && printf ',\n' || printf '\n'
  done
  printf '  ]\n}\n'
} > "$ROOT/docs/phase5/back-button-matrix.json"
echo "evidence: docs/phase5/back-button-matrix.json"

[ "$FAIL" = "0" ] || exit 1
