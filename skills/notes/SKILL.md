---
name: notes
description: Ler, listar e escrever as notas Markdown da pasta Notes do dono (Notes/<projeto>/...) com checagem de versão. Use para consultar decisões e documentos, ou para gravar um documento novo ou revisado.
---

# Notes

As notas ficam como arquivos comuns numa pasta (fonte da verdade = o disco), organizadas por
projeto: `Orion/...`, `Acme/...`. O dono as vê e edita na barra lateral do Cloudroom → **Notes**.

## Comandos

```sh
room-cli notes vaults                      # pastas (cofres) configuradas
room-cli notes list [pasta] [--json]       # árvore de arquivos
room-cli notes read <caminho> [--json]     # conteúdo + hash da versão
room-cli notes write <caminho> --expect-hash <hash> --content "<texto completo>"
```

## Regras

1. **Sempre leia antes de escrever** e passe o `hash` recebido em `--expect-hash`. Se o arquivo mudou
   (o dono pode estar editando), o comando falha com `CONFLITO` e **não grava nada**: leia de novo,
   refaça a alteração em cima da versão nova e tente outra vez.
2. `write` só grava arquivos que já existem. Para criar um documento novo, peça ao dono ou use
   a interface; nunca tente sobrescrever às cegas.
3. Caminhos são relativos à raiz, com `/`. Nada de `..`, caminhos absolutos ou pastas ocultas
   (`.lixeira`, `.git`): são recusados.
4. Não existe apagar. O dono remove pela interface, que move para `.lixeira` (restaurável).
5. Escreva em Markdown simples; mantenha o cabeçalho `--- ... ---` (frontmatter) se existir.
