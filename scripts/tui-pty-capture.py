import os, pty, select, sys, time, fcntl, termios, struct
sid = open('/tmp/sid.txt').read().strip()
argv = ['node', 'apps/clikcode/dist/index.js', 'sessions', 'open', sid]
pid, fd = pty.fork()
if pid == 0:
    os.chdir('/home/justin-gracier/projects/clikdeploy')
    os.execvp(argv[0], argv)
# Phone-ish size: 56 cols x 72 rows, matching the user's cursor.log.
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 72, 56, 0, 0))
out = bytearray()
start = time.time()
sent = False
while time.time() - start < 75:
    r, _, _ = select.select([fd], [], [], 0.5)
    if r:
        try: chunk = os.read(fd, 65536)
        except OSError: break
        if not chunk: break
        out += chunk
    if not sent and time.time() - start > 6:
        os.write(fd, b'reply with exactly: BANANA\r'); sent = True
    if sent and b'BANANA' in out and time.time() - start > 30:
        break
os.write(fd, b'\x04')
time.sleep(1)
open('/tmp/tui2.bin','wb').write(bytes(out))
print('captured', len(out), 'bytes')
