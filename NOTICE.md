# Avisos de terceiros

Partes deste plugin são adaptadas do plugin **Docs** (`bb-plugin-simple-notes`) do
repositório https://github.com/get-bb/bb, licenciado sob MIT:

    MIT License — Copyright (c) 2026 Michael Yong

    Permission is hereby granted, free of charge, to any person obtaining a copy
    of this software and associated documentation files (the "Software"), to deal
    in the Software without restriction, including without limitation the rights
    to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
    copies of the Software, and to permit persons to whom the Software is
    furnished to do so, subject to the following conditions:

    The above copyright notice and this permission notice shall be included in all
    copies or substantial portions of the Software.

    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
    IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
    FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
    AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
    LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
    OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
    SOFTWARE.

Arquivos adaptados: `lib/markdown-blocks.ts`, `lib/editor-extensions.ts`,
`lib/raw-html.ts` (preservação byte a byte de blocos não editados, tabelas
Markdown, HTML cru). O restante (servidor de arquivos seguro, árvore, conflito,
lixeira, CLI) foi escrito do zero para este plugin.
