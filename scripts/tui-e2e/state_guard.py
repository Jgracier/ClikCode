"""Harnesses run the real ClikCode, and ClikCode deletes what its index no longer lists.
A run pointed at the user's own ~/.clikcode once wiped every saved conversation and
account. Every harness that builds an environment for ClikCode, or writes into a
state directory, calls refuse_real_state() on that directory first."""
import os
import pwd


def real_state_dir():
    return os.path.realpath(os.path.join(pwd.getpwuid(os.getuid()).pw_dir, '.clikcode'))


def refuse_real_state(path):
    """Exit unless `path` is somewhere other than the user's real state directory (or a parent of it)."""
    if not path:
        raise SystemExit('refusing to run: no state directory given (CLIKCODE_HOME must be a throwaway directory)')
    resolved = os.path.realpath(path)
    real = real_state_dir()
    if resolved == real or real.startswith(resolved.rstrip(os.sep) + os.sep):
        raise SystemExit(f'refusing to run against the real ClikCode state {real}: use a throwaway CLIKCODE_HOME')
    return path
