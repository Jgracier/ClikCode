/* ClikCode compatibility layer: the few system functions a program built for a newer macOS imports and an older macOS does not have.
 * Loaded into the program with DYLD_INSERT_LIBRARIES + DYLD_FORCE_FLAT_NAMESPACE. Each function does what the newer one does where the older
 * system has the pieces, and otherwise reports "unsupported" the way the real one does when a feature is missing. */
#include <stdint.h>
#include <stddef.h>
#include <sys/types.h>
#include <sys/uio.h>
#include <unistd.h>
#include <dlfcn.h>
#include <errno.h>

typedef uint16_t UChar;
typedef int32_t UErrorCode;
enum { U_ZERO_ERROR = 0, U_UNSUPPORTED_ERROR = 16 };
#define FAIL(status) do { if ((status) && *(status) <= U_ZERO_ERROR) *(status) = U_UNSUPPORTED_ERROR; } while (0)
#define REAL(name) dlsym(RTLD_DEFAULT, name)

/* ── libicucore (ICU) ── */
void* ubrk_clone(const void* iterator, UErrorCode* status) {
  typedef void* (*fn)(const void*, void*, int32_t*, UErrorCode*);
  fn f = (fn)REAL("ubrk_safeClone");
  if (!f) { FAIL(status); return NULL; }
  return f(iterator, NULL, NULL, status);
}
int32_t ucal_getHostTimeZone(UChar* result, int32_t capacity, UErrorCode* status) {
  typedef int32_t (*fn)(UChar*, int32_t, UErrorCode*);
  fn f = (fn)REAL("ucal_getDefaultTimeZone");
  if (!f) { FAIL(status); return 0; }
  return f(result, capacity, status);
}
void ucal_getTimeZoneOffsetFromLocal(const void* calendar, int32_t nonExisting, int32_t duplicated, int32_t* rawOffset, int32_t* dstOffset, UErrorCode* status) {
  typedef int32_t (*fn)(const void*, int32_t, UErrorCode*);
  fn get = (fn)REAL("ucal_get");
  (void)nonExisting; (void)duplicated;
  if (!get) { FAIL(status); return; }
  if (rawOffset) *rawOffset = get(calendar, 15 /* UCAL_ZONE_OFFSET */, status);
  if (dstOffset) *dstOffset = get(calendar, 16 /* UCAL_DST_OFFSET */, status);
}
void* ulistfmt_openForType(const char* locale, int32_t type, int32_t width, UErrorCode* status) {
  typedef void* (*fn)(const char*, UErrorCode*);
  fn f = (fn)REAL("ulistfmt_open");
  (void)type; (void)width;
  if (!f) { FAIL(status); return NULL; }
  return f(locale, status);
}
void udtitvfmt_formatCalendarToResult(const void* f, void* from, void* to, void* result, UErrorCode* status) { (void)f; (void)from; (void)to; (void)result; FAIL(status); }
/* The engine opens a number-range formatter whenever it builds an Intl.NumberFormat, and only uses it for formatRange, so opening must succeed;
 * formatting a range is what reports "unsupported". */
#include <stdlib.h>
void* unumrf_openForSkeletonWithCollapseAndIdentityFallback(const UChar* skeleton, int32_t length, int32_t collapse, int32_t identity, const char* locale, void* parseError, UErrorCode* status) { (void)skeleton; (void)length; (void)collapse; (void)identity; (void)locale; (void)parseError; (void)status; return calloc(1, 16); }
void* unumrf_openResult(UErrorCode* status) { (void)status; return calloc(1, 16); }
void unumrf_close(void* formatter) { free(formatter); }
void unumrf_closeResult(void* result) { free(result); }
void unumrf_formatDoubleRange(const void* f, double a, double b, void* result, UErrorCode* status) { (void)f; (void)a; (void)b; (void)result; FAIL(status); }
void unumrf_formatDecimalRange(const void* f, const char* a, int32_t al, const char* b, int32_t bl, void* result, UErrorCode* status) { (void)f; (void)a; (void)al; (void)b; (void)bl; (void)result; FAIL(status); }
const void* unumrf_resultAsValue(const void* result, UErrorCode* status) { (void)result; FAIL(status); return NULL; }
int32_t uplrules_selectForRange(const void* rules, const void* range, UChar* keyword, int32_t capacity, UErrorCode* status) { (void)rules; (void)range; (void)keyword; (void)capacity; FAIL(status); return 0; }

/* ── libSystem ── */
extern int __ulock_wait(uint32_t operation, void* address, uint64_t value, uint32_t timeoutMicroseconds);
int __ulock_wait2(uint32_t operation, void* address, uint64_t value, uint64_t timeoutNanoseconds, uint64_t value2) {
  (void)value2;
  uint64_t us = timeoutNanoseconds == 0 ? 0 : (timeoutNanoseconds + 999) / 1000;
  if (us > 0xFFFFFFFFull) us = 0xFFFFFFFFull;
  return __ulock_wait(operation, address, value, (uint32_t)us);
}
ssize_t clikcode_preadv(int fd, const struct iovec* iov, int count, off_t offset) __asm("_preadv$NOCANCEL");
ssize_t clikcode_preadv(int fd, const struct iovec* iov, int count, off_t offset) {
  ssize_t total = 0;
  for (int i = 0; i < count; i++) {
    ssize_t n = pread(fd, iov[i].iov_base, iov[i].iov_len, offset + total);
    if (n < 0) return total ? total : -1;
    total += n;
    if ((size_t)n < iov[i].iov_len) break;
  }
  return total;
}
ssize_t clikcode_pwritev(int fd, const struct iovec* iov, int count, off_t offset) __asm("_pwritev$NOCANCEL");
ssize_t clikcode_pwritev(int fd, const struct iovec* iov, int count, off_t offset) {
  ssize_t total = 0;
  for (int i = 0; i < count; i++) {
    ssize_t n = pwrite(fd, iov[i].iov_base, iov[i].iov_len, offset + total);
    if (n < 0) return total ? total : -1;
    total += n;
    if ((size_t)n < iov[i].iov_len) break;
  }
  return total;
}
int pthread_self_is_exiting_np(void) { return 0; }

/* ── posix_spawn: the portable name for what 10.15 calls addfchdir_np ── */
extern int posix_spawn_file_actions_addfchdir_np(void* actions, int fd);
int posix_spawn_file_actions_addfchdir(void* actions, int fd) { return posix_spawn_file_actions_addfchdir_np(actions, fd); }

/* ── Intl.NumberFormat: the engine writes its number-format skeleton in the newer ICU spelling; the older ICU in macOS 10.15 rejects some tokens. ──
 * Asked as written first; on a syntax error, asked again with the old spelling of the same thing (the star form of integer-width is the plus form there). */
#include <string.h>
static void* icu_symbol(const char* name) {
  static void* lib;
  if (!lib) lib = dlopen("/usr/lib/libicucore.A.dylib", RTLD_NOW);
  return lib ? dlsym(lib, name) : NULL;
}
static int replace_ascii(char* text, int length, const char* from, const char* to, int cap) {
  int fl = (int)strlen(from), tl = (int)strlen(to);
  for (int i = 0; i + fl <= length; i++) {
    if (memcmp(text + i, from, (size_t)fl) != 0) continue;
    if (length - fl + tl >= cap) return length;
    memmove(text + i + tl, text + i + fl, (size_t)(length - i - fl));
    memcpy(text + i, to, (size_t)tl);
    length += tl - fl; i += tl - 1;
  }
  return length;
}
void* unumf_openForSkeletonAndLocale(const UChar* skeleton, int32_t length, const char* locale, UErrorCode* status) {
  typedef void* (*fn)(const UChar*, int32_t, const char*, UErrorCode*);
  fn real = (fn)icu_symbol("unumf_openForSkeletonAndLocale");
  if (!real) { FAIL(status); return NULL; }
  UErrorCode before = status ? *status : U_ZERO_ERROR;
  void* result = real(skeleton, length, locale, status);
  if (!status || *status <= U_ZERO_ERROR || length <= 0 || length > 400) return result;
  char text[512]; UChar again[512];
  for (int32_t i = 0; i < length; i++) { if (skeleton[i] > 126) return result; text[i] = (char)skeleton[i]; }
  int n = replace_ascii(text, length, "integer-width/*", "integer-width/+", 500);
  n = replace_ascii(text, n, "sign-accounting-negative", "sign-accounting", 500);
  n = replace_ascii(text, n, "sign-negative", "sign-auto", 500);
  if (n == length && memcmp(text, "", 0) == 0) { /* nothing changed in length: compare content below */ }
  for (int i = 0; i < n; i++) again[i] = (UChar)text[i];
  int same = (n == length); for (int i = 0; same && i < n; i++) if (again[i] != skeleton[i]) same = 0;
  if (same) return result;
  *status = before;
  return real(again, n, locale, status);
}

/* ── start-up ──
 * With every image in one flat namespace a framework that is opened later finds its own dependencies only if they are already loaded, and the
 * loader opens IOKit before CoreFoundation (Security -> IOKit -> CoreFoundation): so CoreFoundation and Security are opened first, here.
 * The two variables that brought this library in are removed again, so the shells, git and node the program starts do not inherit a flat namespace. */
#include <stdlib.h>
__attribute__((constructor)) static void clikcode_compat_start(void) {
  unsetenv("DYLD_INSERT_LIBRARIES");
  unsetenv("DYLD_FORCE_FLAT_NAMESPACE");
  dlopen("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation", RTLD_NOW | RTLD_GLOBAL);
  dlopen("/System/Library/Frameworks/Security.framework/Security", RTLD_NOW | RTLD_GLOBAL);
  dlopen("/System/Library/Frameworks/SystemConfiguration.framework/SystemConfiguration", RTLD_LAZY | RTLD_GLOBAL);
}
