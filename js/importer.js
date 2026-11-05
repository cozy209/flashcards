// Helpers for turning picked video files into signs.

const TYPES = {
  mp4: 'video/mp4',
  m4v: 'video/x-m4v',
  mov: 'video/quicktime',
  webm: 'video/webm',
  '3gp': 'video/3gpp',
};

export const ACCEPT = '.mp4,.m4v,.mov,.webm,.3gp,video/mp4,video/quicktime';

/** "thank_you (1).mp4" → "Thank you" */
export function parseSignName(filename) {
  let n = filename.replace(/\.[^.]+$/, '');
  n = n.replace(/\s*\(\d+\)$/, ''); // " (1)" suffix added when a file is downloaded twice
  n = n.replace(/_+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!n) n = filename;
  return n.charAt(0).toUpperCase() + n.slice(1);
}

export const isVideoName = (name) => !name.startsWith('.') && Object.hasOwn(TYPES, (name.split('.').pop() || '').toLowerCase());

/** True for zip entries that are real videos (not macOS "__MACOSX/._x.mp4" metadata). */
export const isVideoEntry = (path) => !path.split('/').includes('__MACOSX') && isVideoName(path.split('/').pop());

/** "Alphabet-20261105T101500Z-001.zip" (Google Drive folder download) → "Alphabet" */
export function deckNameFromZip(filename) {
  let n = filename.replace(/\.zip$/i, '');
  n = n.replace(/\s*\(\d+\)$/, '');
  n = n.replace(/-\d{8}T\d{6}Z-\d{3}$/, '');
  n = n.replace(/\s+/g, ' ').trim();
  return n || filename;
}

export function videoType(file) {
  if (file.type) return file.type;
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  return TYPES[ext] || 'video/mp4';
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
export const naturalCompare = (a, b) => collator.compare(a, b);
