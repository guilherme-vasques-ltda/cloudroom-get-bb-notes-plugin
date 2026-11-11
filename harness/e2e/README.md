# Capturas de tela (só desenvolvimento)

`captures.mjs` roda o app REAL (`app.tsx` + `server.ts`) num Chrome headless contra um cofre **fictício** (`harness/seed.sh`),
com o SDK simulado de `harness/`. Requer `playwright-core` instalado fora do projeto (ex.: `/tmp/pw`) e o Google Chrome.

```sh
room-cli plugin build && node harness/build.mjs && ./harness/seed.sh /tmp/notes-demo
NOTES_ROOT=/tmp/notes-demo node harness/dist/run.mjs &
cd /tmp/pw && node <caminho>/harness/e2e/captures.mjs   # grava em docs/capturas/
```
Nunca aponte `NOTES_ROOT` para notas reais ao gerar imagens que serão publicadas.
