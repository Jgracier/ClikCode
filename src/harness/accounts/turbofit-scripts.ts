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
            # TurboFit keeps one manual profile; selecting another replaced
            # it, and the controller's saved state still names the old one,
            # which it then refuses to retire ("cannot safely retire unknown
            # previous profile"). Its models are stopped just above, so the
            # state it would retire them from is dropped with them.
            for name in ("controller.json", "runtime-state.json"):
                (state / name).unlink(missing_ok=True)
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

/** Every TurboFit model that can run on this machine's CPU: a GGUF recipe
 * (not MLX) whose files TurboFit publishes pinned downloads for, whose
 * native runtime resolves for this machine, and whose files fit in memory
 * with room for its context. For each, what its speed estimate needs: total
 * and active parameters (a mixture of experts reads only its active share
 * per token) and the compression format, whose CPU kernels differ by 3x
 * at the same size. TurboFit's own recommendations are GPU-measured and
 * offer one model per memory tier; this is the list a CPU is chosen from.
 * argv: plugin root. */
export const TURBOFIT_CPU_LANES_SCRIPT = String.raw`
import json, os, re, sys
from pathlib import Path
root = Path(sys.argv[1])
sys.path.insert(0, str(root / "src"))
from turbofit_runtime.hardware import probe_hardware
from turbofit_runtime.recipes import RecipeBook
hardware = probe_hardware()
book = RecipeBook.load(root / "references" / "model-recipes.json", hardware=hardware)
recipes = json.loads((root / "references" / "model-recipes.json").read_text(encoding="utf-8"))
catalog = {m["id"]: m for m in json.loads((root / "references" / "model-catalog.json").read_text(encoding="utf-8")).get("models", [])}
manifest = {a["destination"]: a for a in json.loads((root / "references" / "artifact-manifest.json").read_text(encoding="utf-8")).get("artifacts", [])}
model_root = Path(os.environ.get("TURBOFIT_MODEL_ROOT", "~/Models/storage/gguf")).expanduser()
usable_mb = hardware.host_usable_memory_mb
cores = os.cpu_count() or 8
try:
    cores = len({line.split(":")[1].strip() for line in open("/proc/cpuinfo") if line.startswith("core id")}) or cores
except OSError:
    cores = max(1, cores // 2)
lanes = []
for variant, spec in (recipes.get("variants") or {}).items():
    if spec.get("engine") == "mlx" or not str(spec.get("model", "")).endswith(".gguf"):
        continue
    paths = [spec.get(key) for key in ("model", "projector", "draft") if spec.get(key)]
    relative = [p.replace("$" "{TURBOFIT_MODEL_ROOT}/", "") for p in paths]  # "$" "{": no JS interpolation
    rows = [manifest.get(r) for r in relative]
    if not rows or not all(rows):
        continue
    try:
        recipe = book.resolve_catalog_configuration({"id": f"{variant}-auto-64k", "main": variant, "auxiliary": "auto", "context": 65536, "status": "candidate"})
    except Exception:
        continue
    total_bytes = sum(int(r["size_bytes"]) for r in rows)
    main_bytes = int(rows[0]["size_bytes"])
    # Weights plus a 64K context and llama.cpp's buffers, inside what TurboFit
    # itself counts as usable (RAM less its host reserve).
    if total_bytes < 100_000_000 or total_bytes / 1048576 * 1.25 + 2048 > usable_mb:
        continue
    entry = catalog.get(variant, {})
    name = str(entry.get("name") or variant)
    moe = re.search(r"(\d+(?:\.\d+)?)B-A(\d+(?:\.\d+)?)B", name) or re.search(r"(\d+(?:\.\d+)?)A(\d+(?:\.\d+)?)B", str(entry.get("family", "")))
    dense = re.search(r"(\d+(?:\.\d+)?)B", name)
    total_b = float(moe.group(1)) if moe else float(dense.group(1)) if dense else main_bytes / 0.6e9
    active_b = float(moe.group(2)) if moe else total_b
    binaries = sorted({c.command[0] for c in recipe.components})
    lanes.append({
        "variant": variant, "name": name, "quant": str(entry.get("quantization") or ""),
        "totalB": total_b, "activeB": active_b, "mainBytes": main_bytes, "totalBytes": total_bytes,
        "binaries": binaries,
        "files": [{"destination": r["destination"], "family": (r.get("families") or [None])[0], "repo": r["repo_id"], "path": r["path"],
                   "size": int(r["size_bytes"]), "present": (model_root / r["destination"]).is_file()} for r in rows],
    })
print("\x00TURBOFIT_LANES" + json.dumps({"pool": hardware.memory_pool_kind, "usableMb": usable_mb, "cores": cores, "lanes": lanes}))
`;

/** Select one CPU lane: TurboFit's own manual-profile writer, given the
 * recipe for this variant at a 64K context and the memory it will hold,
 * then TurboFit's own selector. The same two steps TurboFit takes for a
 * recommendation, without its gate that admits only GPU-benchmarked
 * winners. argv: plugin root, variant, resident MB. */
export const TURBOFIT_CPU_LANE_SELECT_SCRIPT = String.raw`
import importlib.util, json, sys
from pathlib import Path
root, variant, resident_mb = Path(sys.argv[1]), sys.argv[2], int(sys.argv[3])
sys.path.insert(0, str(root / "src"))
from turbofit_runtime.hardware import probe_hardware
from turbofit_runtime.recipes import RecipeBook
from turbofit_runtime.manual_profiles import write_manual_profile
hardware = probe_hardware()
book = RecipeBook.load(root / "references" / "model-recipes.json", hardware=hardware)
configuration = {"id": f"cpu-{variant}-64k", "main": variant, "auxiliary": "auto", "context": 65536, "status": "candidate"}
recipe = book.resolve_catalog_configuration(configuration)
profile_id = "manual-" + configuration["id"]
config_dir = Path.home() / ".config" / "turbofit"
write_manual_profile(config_dir, profile_id=profile_id,
    profile_entry={"context": 65536, "metrics": {"gpu_peak_mb": {"0": resident_mb}}}, recipe=recipe, hardware=hardware)
# With no GPU, TurboFit's resolver gives each role an empty GPU index and its
# own writer records it so; its loader then refuses the file ("runtime gpu
# must be a non-empty string"), so no manual profile has ever loaded on a CPU.
# The index means nothing there -- the recipe runs with -ngl 0 -- and "0" is
# what its GPU-measured profiles carry.
resolutions_path = config_dir / "manual-runtime-resolutions.json"
resolutions = json.loads(resolutions_path.read_text(encoding="utf-8"))
for rungs in (resolutions.get("profiles") or {}).values():
    for roles in rungs.values():
        for role in roles.values():
            if isinstance(role, dict) and role.get("gpu") == "":
                role["gpu"] = "0"
resolutions_path.write_text(json.dumps(resolutions, indent=2, sort_keys=True) + "\n", encoding="utf-8")
spec = importlib.util.spec_from_file_location("clikcode_turbofit_plugin_tools", root / "plugin_tools.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
try:
    payload = module.select_profile(profile_id)
except Exception as exc:
    print("\x00TURBOFIT_SELECTION" + json.dumps({"error": str(exc)}))
    sys.exit(2)
print("\x00TURBOFIT_SELECTION" + json.dumps({**payload, "profile_id": profile_id}))
`;

/** CPU launch settings for one CPU lane, written into TurboFit's own recipe
 * data as the typed launch overrides it already supports, for the 64K
 * context CPU lanes run at only -- TurboFit's GPU-measured profiles run at
 * other contexts and are untouched. Measured with llama-bench on an 8-core
 * Zen 4 with Ornith 35B-A3B:
 *  - The quantized KV cache TurboFit's recipe sets (q4_0) halves prompt
 *    reading on a CPU once context builds up: 36.8 tokens/s at 8K deep,
 *    69.5 with f16, generation unchanged (15.1 vs 16.2). It saves memory a
 *    GPU is short of; a CPU with RAM to spare pays in speed. f16 cost 4.7 GB
 *    more at 64K there, so it is used only with 16 GB of headroom.
 *  - Reading is fastest a little past the physical cores (12 threads: 103
 *    tokens/s against 97 at 8), writing at exactly them (8: 20.8 against 18);
 *    llama.cpp takes the two separately. Past that, hyperthreads contend
 *    (16 threads: 66).
 * Prints whether anything changed, so a changed launch is re-measured.
 * argv: plugin root, variant. */
export const TURBOFIT_CPU_TUNE_SCRIPT = String.raw`
import copy, json, os, sys
from pathlib import Path
root, variant = Path(sys.argv[1]), sys.argv[2]
sys.path.insert(0, str(root / "src"))
from turbofit_runtime.hardware import probe_hardware
path = root / "references" / "model-recipes.json"
recipes = json.loads(path.read_text(encoding="utf-8"))
spec = recipes["variants"][variant]
family = recipes["models"][spec["family"]]
manifest = {a["destination"]: a for a in json.loads((root / "references" / "artifact-manifest.json").read_text(encoding="utf-8")).get("artifacts", [])}
files = [spec.get(k) or family.get(k) for k in ("model", "projector", "draft")]
total_mb = sum(int(manifest.get(str(f).replace("$" "{TURBOFIT_MODEL_ROOT}/", ""), {}).get("size_bytes", 0)) for f in files if f) / 1048576
hardware = probe_hardware()
logical = os.cpu_count() or 8
try:
    cores = len({line.split(":")[1].strip() for line in open("/proc/cpuinfo") if line.startswith("core id")}) or max(1, logical // 2)
except OSError:
    cores = max(1, logical // 2)
tuning = {"threads": cores, "threads_batch": min(logical, cores + cores // 2)}
if hardware.host_usable_memory_mb - total_mb >= 16384:
    tuning.update({"cache_type_k": "f16", "cache_type_v": "f16"})
# A variant's keys replace its family's, so the family's context overrides
# are carried into the variant before the 64K entry is tuned.
contexts = copy.deepcopy(spec.get("context_overrides") or family.get("context_overrides") or {})
entry = contexts.setdefault("65536", {})
before = entry.get("launch_overrides")
entry["launch_overrides"] = {**(before or {}), **tuning}
changed = entry["launch_overrides"] != before
if changed:
    spec["context_overrides"] = contexts
    temporary = path.with_suffix(".json.clikcode")
    temporary.write_text(json.dumps(recipes, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)
print("\x00TURBOFIT_TUNED" + json.dumps({"changed": changed, "tuning": tuning}))
`;
