import re,sys,statistics
def analyse(path):
    t=open(path).read()
    frames=re.split(r'\n(?====== )',t)
    pts=[]
    for f in frames:
        m=re.match(r'===== ([\d.]+)s',f)
        if not m: continue
        words=re.findall(r'\bw(\d\d)\b',f)
        if words: pts.append((float(m.group(1)),max(int(w) for w in words)))
    # time each word index first appears
    first={}
    for tm,n in pts:
        for i in range(1,n+1): first.setdefault(i,tm)
    if 80 not in first or 1 not in first: return None
    times=[first[i] for i in range(1,81)]
    span=times[-1]-times[0]
    # frames that advanced the stream
    adv=[]; last=0
    for tm,n in pts:
        if n>last: adv.append(tm); last=n
    gaps=[b-a for a,b in zip(adv,adv[1:])]
    return span,len(adv),statistics.median(gaps)*1000,max(gaps)*1000
for p in sys.argv[1:]:
    r=analyse(p)
    print(p.split('/')[-2][:48].ljust(48), f'80 words in {r[0]:.2f} s (ideal 4.80 s) | {r[1]} visible updates | between updates median {r[2]:.0f} ms, worst {r[3]:.0f} ms' if r else 'could not read')
