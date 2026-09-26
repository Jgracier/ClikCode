/** Python run inside TurboFit's own code, so ClikCode asks TurboFit what it
 * needs instead of re-deriving its catalog. Kept apart from turbofit-local.ts
 * because they are programs of their own; String.raw keeps them verbatim. */

/** What the selected TurboFit profile needs on this machine: the native
 * runtime builds and the model files each local rung's llama-server command
 * names. Resolved the way turbofit-controller resolves them (bundled and
 * manual resolutions, a RecipeBook for this hardware), so the answer is the
 * controller's own. argv: plugin root. */
export const TURBOFIT_PLAN_SCRIPT = String.raw`
import json, os, sys
from pathlib import Path
root = Path(sys.argv[1])
sys.path.insert(0, str(root / "src"))
from turbofit_runtime.hardware import probe_hardware
from turbofit_runtime.recipes import RecipeBook
from turbofit_runtime.routes import load_runtime_resolutions_many
config_dir = Path.home() / ".config" / "turbofit"
try:
    selection = json.loads((config_dir / "selection.json").read_text(encoding="utf-8"))
except FileNotFoundError:
    print("\x00TURBOFIT_PLAN" + json.dumps({"selected": None}))
    sys.exit(0)
profile_id = str(selection.get("profile_id") or "")
resolutions = load_runtime_resolutions_many((
    root / "runtime-profiles" / "runtime-resolutions.json",
    config_dir / "manual-runtime-resolutions.json",
))
hardware = probe_hardware()
book = RecipeBook.load(root / "references" / "model-recipes.json", hardware=hardware)
model_root = Path(os.environ.get("TURBOFIT_MODEL_ROOT", "~/Models/storage/gguf")).expanduser()
manifest = json.loads((root / "references" / "artifact-manifest.json").read_text(encoding="utf-8"))
by_destination = {str(row.get("destination")): row for row in manifest.get("artifacts", []) if isinstance(row, dict)}
runtimes = json.loads((root / "references" / "native-runtimes.json").read_text(encoding="utf-8")).get("runtimes", [])
binaries, files, unknown = {}, {}, []
for rung_id, roles in (resolutions.get(profile_id) or {}).items():
    for role, item in roles.items():
        component = book.resolve_component(
            str(item["family"]), role=role, gpu=str(item["gpu"]), port=int(item["port"]),
            context=int(item.get("context", 65536)), alias=str(item["model_tag"]),
        )
        binary = component.command[0]
        runtime = next((r for r in runtimes if f"{r.get('id')}-{r.get('revision')}" in binary), None)
        binaries[binary] = {"binary": binary, "runtime": runtime.get("id") if runtime else None, "present": Path(binary).is_file()}
        for token in component.command[1:]:
            try:
                relative = Path(token).expanduser().resolve().relative_to(model_root.resolve()).as_posix()
            except (ValueError, OSError):
                continue
            row = by_destination.get(relative)
            if row is None:
                if not Path(token).is_file():
                    unknown.append(relative)
                continue
            families = row.get("families") or []
            files[relative] = {
                "destination": relative, "family": families[0] if families else None,
                "repo": row.get("repo_id"), "path": row.get("path"), "size": int(row.get("size_bytes") or 0),
                "present": (model_root / relative).is_file(),
            }
print("\x00TURBOFIT_PLAN" + json.dumps({
    "selected": profile_id, "backend": book.backend_name, "modelRoot": str(model_root),
    "runtimes": list(binaries.values()), "files": list(files.values()), "unknown": sorted(set(unknown)),
}))
`;

/** Owns TurboFit's controller and gateway for ClikCode sessions. It runs
 * them while at least one lease file names a live ClikCode process, and
 * stops everything -- controller, gateway, and the llama-server processes
 * the controller keeps resident on purpose -- once none does. Leases are
 * files, one per ClikCode process and session, so no two writers share one;
 * a lease whose process is gone (a closed terminal, a crash) is dropped
 * here, which is what makes "stops when the terminal closes" hold even when
 * ClikCode never got to say so. argv: plugin root, state dir. */
export const TURBOFIT_SUPERVISOR_SCRIPT = String.raw`
import json, os, signal, subprocess, sys, time
from pathlib import Path
root, state = Path(sys.argv[1]), Path(sys.argv[2])
leases = state / "clikcode-leases"
leases.mkdir(parents=True, exist_ok=True)
marker = state / "clikcode-supervisor.json"
WINDOWS = os.name == "nt"

def alive(pid):
    if pid <= 0:
        return False
    if WINDOWS:
        out = subprocess.run(["tasklist", "/FI", f"PID eq {pid}", "/NH"], capture_output=True, text=True).stdout
        return str(pid) in out
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True

def live_leases():
    count = 0
    for path in leases.glob("*.json"):
        try:
            pid = int(json.loads(path.read_text(encoding="utf-8")).get("pid", 0))
        except (OSError, ValueError):
            pid = 0
        if alive(pid):
            count += 1
        else:
            path.unlink(missing_ok=True)
    return count

def command_line(pid):
    try:
        if WINDOWS:
            return subprocess.run(["tasklist", "/FI", f"PID eq {pid}", "/NH"], capture_output=True, text=True).stdout
        proc = Path(f"/proc/{pid}/cmdline")
        if proc.exists():
            return proc.read_bytes().replace(b"\0", b" ").decode(errors="replace")
        return subprocess.run(["ps", "-o", "command=", "-p", str(pid)], capture_output=True, text=True).stdout
    except OSError:
        return ""

def stop(child):
    if child.poll() is not None:
        return
    child.terminate()
    try:
        child.wait(timeout=15)
    except subprocess.TimeoutExpired:
        child.kill()

def stop_models():
    # The controller keeps llama-server resident by design; its records say
    # which ones it owns. Only a process that still is a llama-server is
    # stopped, so a recycled pid is left alone.
    for role in ("main", "aux"):
        try:
            pid = int(json.loads((state / "native" / f"{role}.json").read_text(encoding="utf-8"))["pid"])
        except (OSError, ValueError, KeyError, TypeError):
            continue
        if not alive(pid) or "llama-server" not in command_line(pid):
            continue
        try:
            if WINDOWS:
                subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"], capture_output=True)
            else:
                os.kill(pid, signal.SIGTERM)
                for _ in range(30):
                    if not alive(pid):
                        break
                    time.sleep(0.5)
                if alive(pid):
                    os.kill(pid, signal.SIGKILL)
        except OSError:
            pass

python = sys.executable
env = dict(os.environ, PYTHONUNBUFFERED="1", PYTHONPATH=str(root / "src"))
logs = state / "clikcode-logs"
logs.mkdir(parents=True, exist_ok=True)
flags = {"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP} if WINDOWS else {}
restart = state / "clikcode-restart"
restart.unlink(missing_ok=True)

def start(script, log):
    return subprocess.Popen([python, str(root / "scripts" / script)], cwd=root, env=env,
        stdout=open(logs / log, "a"), stderr=subprocess.STDOUT, **flags)

def record():
    marker.write_text(json.dumps({"pid": os.getpid(), "controller": controller.pid, "gateway": gateway.pid}), encoding="utf-8")

# SIGTERM (a logout, a shutdown) ends the loop like a lost lease, so the
# models are still stopped on the way out.
if not WINDOWS:
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    signal.signal(signal.SIGHUP, lambda *_: sys.exit(0))
controller = start("turbofit-controller", "controller.log")
gateway = start("turbofit-gateway.py", "gateway.log")
record()
reason = "no ClikCode session is using TurboFit"
try:
    while True:
        time.sleep(2)
        if restart.exists():
            # A different model was selected: the controller loads profiles
            # only at start, so it is restarted, and the old model stopped.
            restart.unlink(missing_ok=True)
            stop(controller)
            stop_models()
            controller = start("turbofit-controller", "controller.log")
            record()
            continue
        if controller.poll() is not None:
            reason = f"controller exited ({controller.returncode})"
            break
        if gateway.poll() is not None:
            reason = f"gateway exited ({gateway.returncode})"
            break
        if live_leases() == 0:
            break
except SystemExit:
    reason = "stopped by a signal"
finally:
    stop(controller)
    stop(gateway)
    stop_models()
    marker.unlink(missing_ok=True)
    print(json.dumps({"stopped": reason}), flush=True)
`;
