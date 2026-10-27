// The newer libc++ ships std::stringbuf / std::stringstream for char as part of the library; the one in macOS 10.15 builds them into each program
// that uses them. A program built against the newer one expects to find them in libc++, so they are provided here, built from the same templates.
#include <sstream>
template class __attribute__((visibility("default"))) std::basic_stringbuf<char>;
template class __attribute__((visibility("default"))) std::basic_stringstream<char>;
