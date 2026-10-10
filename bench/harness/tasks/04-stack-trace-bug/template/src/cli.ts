import { loadTickets } from './data/load.ts';
import { renderReport } from './report/summary.ts';

const path = process.argv[2] ?? 'tickets.jsonl';
console.log(renderReport(loadTickets(path)));
