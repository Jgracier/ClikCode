/** A terminal note's level, from the colour it was painted in: red is a
 * failure, yellow a warning (an account switch, a limit), anything else
 * information. The bridge sends the level with the notes it forwards (`worker`
 * events' `level`); the editor reads it only where it has just the text (a
 * notice kept in a turn's marks). */
export function noticeLevel(text: string): 'info' | 'warning' | 'error' {
  // eslint-disable-next-line no-control-regex
  const colour = /\u001b\[(?:[0-9;]*;)?(3[13]|9[13])m/.exec(text)?.[1];
  return colour === '31' || colour === '91' ? 'error' : colour === '33' || colour === '93' ? 'warning' : 'info';
}
