# macOS compatibility library

Lets a vendor program built for a newer macOS start on an **Intel Mac that cannot update** (a 2012-2016 iMac or MacBook stuck on macOS 10.15, 11
or 12). Claude Code is built for macOS 13; on 10.15 it dies at launch with `dyld: Symbol not found: _ubrk_clone ... built for Mac OS X 13.0`.

It is not used on any other Mac. `src/harness/compat/macos-legacy.ts` decides when, prepares a copy of the program without its code signature
(which would otherwise stop macOS loading this library into it) and starts that copy with:

    DYLD_INSERT_LIBRARIES=libclikcode-compat-x64.dylib DYLD_FORCE_FLAT_NAMESPACE=1

The library removes both variables again as it loads, so programs the vendor program starts do not inherit them.

## What it supplies

| For | Functions | How |
|---|---|---|
| ICU (`libicucore`) | `ubrk_clone`, `ucal_getHostTimeZone`, `ucal_getTimeZoneOffsetFromLocal`, `ulistfmt_openForType` | the older ICU's own equivalent |
| ICU number formatting | `unumf_openForSkeletonAndLocale` | asks as written, and on a syntax error again in the older ICU's spelling (`integer-width/*0` is `integer-width/+0`) |
| ICU ranges | `unumrf_*`, `uplrules_selectForRange`, `udtitvfmt_formatCalendarToResult` | open succeeds (the JavaScript engine opens one for every `Intl.NumberFormat`); formatting a *range* reports "unsupported" |
| libSystem | `__ulock_wait2`, `preadv`/`pwritev` (`$NOCANCEL`), `pthread_self_is_exiting_np`, `posix_spawn_file_actions_addfchdir` | the older system's call that does the same |
| libc++ | `std::stringbuf` / `std::stringstream` for `char` (vtables, `str()`) | built here from the same templates |
| start-up | CoreFoundation, Security | opened first: in one flat namespace a framework opened later finds its dependencies only if they are already loaded |

## Rebuilding

`sh native/macos-compat/build.sh` on any Mac with the Command Line Tools. The built `libclikcode-compat-x64.dylib` is committed, and the build
copies it to `dist/`.

## Limits

Unsupported by the vendor. It stands in for system functions: a feature that needs the real ones (number *ranges* in `Intl`) can fail where a newer
Mac would not. Found by running the program on a Mac with macOS 10.15.8: when the vendor's next release imports something the older system lacks,
the program stops at launch with the loader's "Symbol not found" naming it, and the fix is one more function here.
