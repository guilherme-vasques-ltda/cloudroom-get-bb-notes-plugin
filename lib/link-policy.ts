// Quais destinos de link o editor formatado preserva. Remove espaços e caracteres de controle antes de
// olhar o esquema, para "java\tscript:" ou " javascript:" não passarem por relativos.
const INVISIBLE = new RegExp("[\\u0000-\\u0020\\u007f-\\u00a0\\u2000-\\u2029\\u3000\\ufeff]", "g");

export function isAllowedLink(url: string, defaultValidate: (u: string) => boolean): boolean {
  const u = url.replace(INVISIBLE, "");
  return defaultValidate(u) || !/^[a-z][a-z0-9+.-]*:/i.test(u) || /^(obsidian|file):/i.test(u);
}
