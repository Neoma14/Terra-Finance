import json,sys,pymupdf
items=json.load(open(sys.argv[1],encoding='utf8')); out=[]
for it in items:
    if it['fmt']!='pdf': continue
    try:
        d=pymupdf.open(it['file']); txt=''.join(p.get_text() for p in d); n=d.page_count
        fm=None
        if it.get('want'):
            s=f"{it['want']:,}".replace(',','.'); fm=s in txt
        out.append({'file':it['file'],'pages':n,'company':'PT TERRA NUSANTARA' in txt,'otherCompany':'PT PEMBANDING' in txt,'amountFound':fm})
    except Exception as e: out.append({'file':it['file'],'error':str(e)})
print(json.dumps(out))