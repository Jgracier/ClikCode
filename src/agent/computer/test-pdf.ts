/** Test helper: a small valid PDF with text per page (lines split on newline) (Helvetica, no compression). */
export function makePdf(pages: string[]): Buffer {
  const objects: string[] = [];
  const add = (body: string): number => { objects.push(body); return objects.length; };
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const pageIds: number[] = [];
  const pagesId = objects.length + 1 + pages.length * 2; // known after the page objects are added
  for (const text of pages) {
    const lines = text.split('\n').map(line => `(${line.replace(/[\\()]/g, '\\$&')}) Tj 0 -16 Td`);
    const stream = `BT /F1 12 Tf 40 750 Td ${lines.join(' ')} ET`;
    const content = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    pageIds.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Contents ${content} 0 R /Resources << /Font << /F1 ${font} 0 R >> >> >>`));
  }
  const pagesObject = add(`<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`);
  if (pagesObject !== pagesId) throw new Error('pdf layout');
  const catalog = add(`<< /Type /Catalog /Pages ${pagesObject} 0 R >>`);
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, index) => { offsets.push(out.length); out += `${index + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
