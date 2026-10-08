// Test fixture: an authoring adapter that records its pid and then never answers (until killed).
import { writeFileSync } from 'node:fs';
writeFileSync(process.env.SLOW_PID_FILE, String(process.pid));
process.stdin.resume();
setInterval(() => {}, 1000);
