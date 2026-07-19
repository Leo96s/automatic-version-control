# automatic-version-control

Sistema de **versionamento semântico automático** baseado em mensagens de commit, com validação e proteção local de commits via Husky. Distribui-se como um instalador que aplica todo o setup a qualquer outro repositório Git.

## Funcionalidades

* Incrementa a versão seguindo o padrão **Semantic Versioning (SemVer)**, a partir das mensagens de commit
* Cria **tags retroativas** no commit correto, reconstruindo o histórico de versões mesmo quando os commits foram feitos fora de branches controladas
* Atualiza automaticamente todos os **`package.json`/`package-lock.json`** do repositório (incluindo subpastas)
* Gera e mantém atualizados os ficheiros **`CHANGELOG.md`** e **`RELEASE_NOTES.md`**
* Publica automaticamente uma **GitHub Release** com as notas da versão
* Ignora commits de merge, commits de release do próprio bot (`chore(release): ...`) e mensagens sem prefixo semântico
* Valida localmente as mensagens de commit (Conventional Commits) antes de permitir o commit
* Bloqueia localmente, antes do commit, ficheiros sensíveis, segredos, ficheiros demasiado grandes e marcadores de conflito por resolver

## Como funciona o versionamento

Um workflow do GitHub Actions (`.github/workflows/versioning.yml`) corre em cada push para `main`/`dev` (ou manualmente via `workflow_dispatch`), percorre os commits desde a última tag e aplica as seguintes regras à mensagem de cada um:

| Mensagem do commit | Efeito na versão |
| --- | --- |
| Contém `breaking change` | major (`X+1.0.0`) |
| `feat:` / `feat(scope):` | minor (`x.Y+1.0`) |
| `fix:`, `docs:`, `style:`, `test:`, `ci:`, `chore:`, `refactor:`, `perf:`, `build:`, `revert:` | patch (`x.y.Z+1`) |
| `chore(release): ...` (commits do próprio bot) | ignorado |
| Sem prefixo reconhecido | ignorado |

Depois de calcular a nova versão, o workflow:

1. Cria a tag `vX.Y.Z` no commit correspondente
2. Atualiza todos os `package.json`/`package-lock.json` rastreados pelo git
3. Acrescenta uma secção nova ao `CHANGELOG.md` e reescreve o `RELEASE_NOTES.md` com as notas da versão atual
4. Faz commit (`chore(release): vX.Y.Z [skip ci]`), push do commit e das tags, e cria a Release no GitHub

## Instalação noutro repositório

Este pacote não está publicado no registo npm (`"private": true`) — corre-se diretamente a partir do repositório GitHub, dentro da raiz do repositório onde o queres aplicar (tem de já ser um repositório git):

```bash
npx github:Leo96s/automatic-version-control
```

O instalador (`bin/install.js`):

* Copia para o repositório de destino: `.github/workflows/versioning.yml`, `commitlint.config.js`, `.secretlintrc.json`, `.lintstagedrc.json` e `scripts/pre-commit-checks.js` (ficheiros geridos por este pacote — são sempre substituídos pela versão mais recente ao voltar a correr o instalador)
* Garante que `node_modules/` está no `.gitignore`
* Adiciona as devDependencies necessárias e o script `prepare` ao `package.json` (encadeando com um `prepare` já existente, se houver)
* Corre `npm install`
* Configura os hooks do Husky (`commit-msg` e `pre-commit`; se já existir um `pre-commit` personalizado, não o substitui — mostra a instrução para o adicionares manualmente)

### Depois de instalar

No repositório de destino, em **Settings → Actions → General**:

* **Workflow permissions** → `Read and write permissions`
* **Actions permissions** → `Allow all actions and reusable workflows`

Sem isto, o workflow não consegue fazer push de tags/commits nem criar Releases.

## Convenção de commits

As mensagens de commit são validadas localmente (`commitlint`, config `@commitlint/config-conventional`) e devem seguir o padrão [Conventional Commits](https://www.conventionalcommits.org/):

```text
feat: adiciona nova funcionalidade
fix: corrige bug X
docs: atualiza documentação
BREAKING CHANGE: descrição da alteração incompatível
```

## Proteções locais de commit (Husky)

Instalados em `.husky/`:

* **`commit-msg`** — corre `commitlint`, rejeitando mensagens que não sigam o padrão Conventional Commits
* **`pre-commit`** — corre, por esta ordem:
  1. `scripts/pre-commit-checks.js`, que bloqueia o commit se detetar:
     * nomes de ficheiro sensíveis (`.env`, `.pem`, `.key`, `.p12`, `.pfx`, `id_rsa`, `credentials.json`, etc.)
     * segredos de alta confiança (ex.: AWS Access Key ID, chave privada PEM)
     * ficheiros com mais de 5MB
     * marcadores de conflito de merge (`<<<<<<<`, `=======`, `>>>>>>>`) por resolver
  2. `lint-staged`, que corre `secretlint` (preset recomendado) sobre todos os ficheiros staged

## Estrutura do projeto

```text
.
├── bin/install.js                    # instalador (npx github:Leo96s/automatic-version-control)
├── scripts/pre-commit-checks.js      # verificações de segurança pre-commit
├── .github/workflows/versioning.yml  # workflow de versionamento semântico
├── commitlint.config.js              # regras de validação de mensagens de commit
├── .secretlintrc.json                # regras de deteção de segredos
├── .lintstagedrc.json                # o que corre sobre ficheiros staged
├── CHANGELOG.md                      # histórico completo de versões
└── RELEASE_NOTES.md                  # notas da versão mais recente
```

## Changelog

O histórico completo de alterações está em [`CHANGELOG.md`](./CHANGELOG.md).

## Licença

[MIT](./LICENSE) © Leonardo Silva
