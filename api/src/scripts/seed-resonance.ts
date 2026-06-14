/**
 * Seed dummy highlights so Resonance ("N others underlined this") is alive.
 * Inserts highlights from synthetic users on the FIRST highlightable paragraph
 * of popular bites — the line a real reader is most likely to long-press, so the
 * normalised line_hash matches. Idempotent: clears synthetic highlights first.
 *
 *   npm run seed:resonance
 */
import { admin } from '../lib/supabase.js';
import { logger } from '../lib/logger.js';

function asObj(v: unknown): Record<string, any> {
  if (v && typeof v === 'object') return v as Record<string, any>;
  if (typeof v === 'string') { try { const d = JSON.parse(v); return d && typeof d === 'object' ? d : {}; } catch { return {}; } }
  return {};
}
// Same selection a reader's long-press yields: first non-heading, non-divider block, ** stripped.
function firstLine(contentEn: string): string | null {
  for (const block of contentEn.split(/\n{2,}/)) {
    const t = block.trim();
    if (!t || /^#{1,4}\s/.test(t) || /^-{3,}$/.test(t)) continue;
    return t.replace(/\*\*/g, '').slice(0, 1000);
  }
  return null;
}

const NOTES = ['This stayed with me.', 'Read it twice.', 'Needed this today.', 'Saving this one.', 'Quietly true.', null, null, null];

async function main() {
  const { data: su } = await admin.from('synthetic_users').select('id');
  const users = (su ?? []).map((u: any) => u.id as string);
  if (!users.length) { logger.error('no synthetic_users — run the seed first'); process.exit(1); }

  // Clear previous synthetic highlights (idempotent re-run).
  await admin.from('highlights').delete().in('user_id', users);

  const { data: bites } = await admin.from('bites').select('id, content').limit(200);
  const rows: any[] = [];
  for (const b of bites ?? []) {
    const line = firstLine(String(asObj(b.content).en ?? ''));
    if (!line) continue;
    // 2–28 readers underlined this opening line.
    const n = 2 + Math.floor(Math.random() * 26);
    const picks = [...users].sort(() => Math.random() - 0.5).slice(0, n);
    for (const uid of picks) {
      rows.push({
        user_id: uid,
        item_kind: 'byte',
        item_id: b.id,
        lang: 'en',
        quote: line,
        note: NOTES[Math.floor(Math.random() * NOTES.length)],
      });
    }
  }

  // Insert in batches (line_hash is set by the DB trigger).
  let written = 0;
  for (let i = 0; i < rows.length; i += 200) {
    const { error } = await admin.from('highlights').insert(rows.slice(i, i + 200));
    if (error) throw error;
    written += Math.min(200, rows.length - i);
  }
  logger.info({ highlights: written, lines: rows.length }, 'resonance seed complete');
}

main().then(() => process.exit(0)).catch((e) => { logger.error({ e }, 'seed failed'); process.exit(1); });
