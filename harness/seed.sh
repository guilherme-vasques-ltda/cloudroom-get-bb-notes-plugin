#!/bin/sh
# Cria um cofre de notas FICTÍCIO para o harness de testes/capturas. Não copia nada do disco do usuário.
set -e
DST="${1:-/tmp/notes-demo}"
rm -rf "$DST"; mkdir -p "$DST/Orion/Decisoes" "$DST/Acme/Reunioes" "$DST/Pessoal/Receitas" "$DST/Pesquisa/Concorrentes/Exemplo SA" "$DST/_testes"
cat > "$DST/Pesquisa/Concorrentes/Exemplo SA/Relatorio.md" <<'MD'
# Exemplo SA — relatório

A **Exemplo SA** é uma empresa fictícia usada nas capturas de tela deste projeto.

## O que faz

Vende cadernos e canetas pela internet. Atende pequenos escritórios em todo o país.

## Pontos fortes

- Entrega rápida
- Preço fixo por pacote
- Atendimento por chat

## Pontos fracos

1. Site lento em celulares
2. Poucas opções de pagamento

Veja também [o plano](../../../Orion/plano.md).
MD
cat > "$DST/Orion/plano.md" <<'MD'
# Plano Orion

Projeto de exemplo. Metas do trimestre:

- [x] Escolher fornecedor
- [ ] Fechar orçamento
- [ ] Publicar a página
MD
cat > "$DST/Orion/Decisoes/escolha-do-fornecedor.md" <<'MD'
# Escolha do fornecedor

Decidimos pelo fornecedor B: preço médio e prazo curto.
MD
cat > "$DST/Acme/Reunioes/semanal.md" <<'MD'
# Reunião semanal

Presentes: Ana, Bruno, Carla. Próximos passos: revisar o orçamento e agendar a demonstração.
MD
printf '# Bolo de laranja\n\nMisture ovos, açúcar e suco de laranja. Asse por 40 minutos.\n' > "$DST/Pessoal/Receitas/bolo-de-laranja.md"
printf '# Ideias soltas\n\nUma lista para pensar depois. A palavra worktree aparece aqui só para a busca.\n' > "$DST/ideias.md"
printf 'ver [plano](Orion/plano.md) fim\n' > "$DST/_testes/links.md"
python3 - "$DST/_testes" <<'PY'
import struct,zlib,sys
d=sys.argv[1]
def png(w,h,rgb):
    raw=b''.join(b'\x00'+bytes(rgb)*w for _ in range(h))
    def ch(t,x):
        c=struct.pack('>I',len(x))+t+x
        return c+struct.pack('>I',zlib.crc32(t+x)&0xffffffff)
    return b'\x89PNG\r\n\x1a\n'+ch(b'IHDR',struct.pack('>IIBBBBB',w,h,8,2,0,0,0))+ch(b'IDAT',zlib.compress(raw))+ch(b'IEND',b'')
open(d+'/logo.png','wb').write(png(240,80,(255,165,0)))
open(d+'/pagina.html','w').write('''<!doctype html><html><head><title>Relatório</title><style>body{font-family:sans-serif;padding:24px;color:#222}h1{color:#c60}</style></head>
<body><h1>Relatório de teste (HTML)</h1><p>Este HTML roda num quadro isolado.</p><img src="logo.png" alt="logo">
<p id="s">Scripts: <b>desligados</b></p><script>document.getElementById('s').innerHTML='Scripts: <b>LIGADOS</b>'</script>
<p><img src="https://example.com/tracker.png" alt="externa (deve ser bloqueada)"></p></body></html>''')
open(d+'/com-imagem.md','w').write('''---
title: Nota de teste
tags: [a, b]
---

# Nota com imagem e tabela

Texto normal com **negrito** e um [link para outra nota](../ideias.md).

![logo laranja](logo.png)

| Coluna A | Coluna B |
| --- | --- |
| 1 | 2 |
| 3 | 4 |

- [ ] tarefa aberta
- [x] tarefa feita

<div class="raw">HTML cru preservado</div>
''')
PY
