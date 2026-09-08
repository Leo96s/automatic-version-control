# automatic-version-control

Sistema de **versionamento semântico automático** baseado em mensagens de commit, com validação e proteção local de commits via Husky. Distribui-se como um instalador que aplica todo o setup a qualquer outro repositório Git.

## Funcionalidades

* Incrementa a versão seguindo o padrão **Semantic Versioning (SemVer)**, a partir das mensagens de commit
* Cria **tags retroativas** no commit correto, reconstruindo o histórico de versões mesmo quando os commits foram feitos fora de branches controladas
* Atualiza automaticamente todos os **`package.json`/`package-lock.json`** do repositório (incluindo subpastas)
* Gera e mantém atualizados os ficheiros **`CHANGELOG.md`** e **`RELEASE_NOTES.md`**
* Publica automaticamente uma **GitHub Release** com as notas da versão
* Sincroniza as versões de plugins locais detetados através de uma extensão instalada apenas em projetos de plugins
* Audita dependências npm e cria/atualiza um Issue do GitHub quando encontra vulnerabilidades **high** ou **critical**
* Disponibiliza uma extensão instalável para evitar que o teu próprio workflow de CI corra duas vezes para o mesmo commit (ver [Evitar execuções duplicadas de CI](#evitar-execuções-duplicadas-de-ci))
* Em projetos **Kotlin/Android ou Flutter**, compila e anexa à Release um **APK de release assinado** (ver [Build + release de APK](#build--release-de-apk-kotlinflutter))
* Ignora commits de merge, commits de release do próprio bot (`chore(release): ...`) e mensagens sem prefixo semântico
* Valida localmente as mensagens de commit (Conventional Commits) antes de permitir o commit
* Bloqueia localmente, antes do commit, ficheiros sensíveis, segredos, ficheiros demasiado grandes e marcadores de conflito por resolver

## Como funciona o versionamento

Um workflow do GitHub Actions (`.github/workflows/versioning.yml`) corre em cada push para `main` (ou manualmente via `workflow_dispatch`), percorre os commits desde a última tag e aplica as seguintes regras à mensagem de cada um. Mesmo quando é iniciado manualmente, só cria releases a partir de `main`:

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
3. Se detetar um projeto Kotlin/Android (`build.gradle.kts`/`build.gradle` com `versionCode`) ou Flutter (`pubspec.yaml`), atualiza também `versionName`/`version` para `X.Y.Z` e incrementa `versionCode`/o número de build em 1 — só um de cada por repositório, mesma deteção do [`mobile-release.yml`](#build--release-de-apk-kotlinflutter)
4. Se detetar metadados de plugins Claude Code ou Codex, sincroniza os manifests e as entradas locais dos marketplaces com a versão final calculada
5. Acrescenta uma secção nova ao `CHANGELOG.md` e reescreve o `RELEASE_NOTES.md` com as notas da versão atual
6. Faz commit (`chore(release): vX.Y.Z [skip ci]`), push do commit e das tags, e cria a Release no GitHub

### Sincronização de plugins

Durante uma release, a sincronização de plugins é ativada pela deteção recursiva de metadados reconhecidos. A pesquisa inclui diretórios ocultos, mas exclui sempre `.git` e `node_modules`. Em repositórios sem esses metadados, o passo não altera nada e é um no-op. São reconhecidos os seguintes caminhos locais:

* **Claude**: `.claude-plugin/plugin.json` e entradas locais em `.claude-plugin/marketplace.json`
* **Codex**: `.codex-plugin/plugin.json` e entradas locais em `.agents/plugins/marketplace.json`

A versão final calculada pela release é a que prevalece quando um único push cria várias tags de versão semântica. Os manifests de plugins reconhecidos e as entradas locais correspondentes dos marketplaces são atualizados automaticamente; fontes externas de marketplace não são alteradas. Numa entrada local do marketplace Codex, o campo `version` só é atualizado se já existir — uma entrada sem esse campo permanece sem ele.

Se um manifest ou marketplace reconhecido estiver malformado, a sincronização falha e a release é abortada antes do commit de release. Para os plugins locais suportados, não é necessário editar manualmente a versão nos manifests ou catálogos.

### Auditoria de dependências npm

Em repositórios com `package-lock.json` ou `npm-shrinkwrap.json` rastreados pelo Git, o instalador copia `.github/workflows/npm-audit.yml` e `scripts/npm-audit.js`. O workflow:

* corre em cada push para `main`, semanalmente e através de `workflow_dispatch`;
* audita todos os diretórios com `package-lock.json` ou `npm-shrinkwrap.json` rastreados pelo Git, incluindo monorepos;
* usa `npm audit --json --audit-level=high`, incluindo dependências de produção e desenvolvimento;
* publica o relatório no Summary da Action;
* cria ou atualiza o Issue aberto `[Security] npm audit requires attention` quando encontra vulnerabilidades `high`/`critical` ou não consegue concluir a auditoria;
* termina com falha para tornar o problema visível, sem bloquear o workflow separado de versionamento/release.

O workflow usa apenas `GITHUB_TOKEN`, com `contents: read` e `issues: write`. O Issue permanece aberto até a resolução e revisão manual. Um projeto com `package.json` mas sem lockfile npm rastreado não recebe este workflow, porque não há uma árvore de dependências reproduzível para auditar. A deteção inclui locks em subpastas de monorepos e exclui sempre `.git` e `node_modules`.

### Testes automáticos de CI (`ci.yml`)

O instalador escolhe entre dois tipos de `.github/workflows/ci.yml`, por esta ordem: primeiro tenta um **template específico** para uma combinação de stacks reconhecida (ver abaixo); só se nenhum corresponder, cai no **template genérico**. Em ambos os casos, uma vez decidido instalar `ci.yml`, ele é **sempre substituído pela versão mais recente ao voltar a correr o instalador, mesmo que a versão existente tenha sido personalizada manualmente** — só é removido, ou preservado se personalizado, quando deixa de haver qualquer stack reconhecida (nem específica nem genérica).

#### Template genérico

Deteta, na raiz e nas subpastas de primeiro nível (mesma convenção do `mobile-release.yml`):

* **Node**: `package.json` com um script `test` definido;
* **Gradle/Kotlin**: `gradlew` + `settings.gradle[.kts]`;
* **Flutter**: `pubspec.yaml` com secção `flutter:`.

O workflow gerado:

1. Um job `pre_job` usa a extensão `skip-duplicate-run` (ver abaixo) para nunca testar duas vezes o mesmo commit.
2. Um job `detect` confirma outra vez em runtime, como rede de segurança, qual das três stacks está presente e em que pasta.
3. Um job independente por stack (`node-tests`, `gradle-tests`, `flutter-tests`) instala as dependências e corre os testes (`npm test`, `./gradlew test`, `flutter test`, respetivamente) — só corre(m) o(s) job(s) da(s) stack(s) realmente presentes.

**Aviso:** a deteção é por stack, não por projeto inteiro. Um repositório com várias linguagens (ex. backend numa linguagem não reconhecida + frontend em Node) recebe este `ci.yml` assim que só uma das três stacks reconhecidas for encontrada — mas o workflow só sabe testar Node, Gradle/Kotlin e Flutter; o resto não é coberto.

#### Templates específicos

Além do genérico, existe um registo de templates dedicados a uma combinação exata de stacks — tentados por ordem, o primeiro que corresponder ganha. Para já há só um:

* **`dotnet-node-docker-e2e`** — deteta um projeto .NET com testes (`.csproj` + `.Tests.csproj`, na raiz ou em subpastas de primeiro nível), um frontend Node (qualquer framework — `package.json` numa subpasta diferente da do backend) e um `compose.yml`/`docker-compose.yml` na raiz. Gera um `ci.yml` com job de testes de backend (`dotnet test`, auditoria de pacotes), job de frontend (testes, cobertura, auditoria `npm audit`, build) e um job de Docker smoke/E2E que sobe a stack de produção via Compose, espera pela migração da base de dados e pela API ficar pronta, e corre os testes E2E do frontend.

  O template não tem nenhum valor específico de um projeto — só os caminhos (pastas do backend/testes/frontend, nomes dos ficheiros Compose) são detetados e substituídos automaticamente na instalação. Tudo o resto (nomes/password da base de dados, JWT, SMTP, projeto Firebase, serviço de migração no Compose, rota e código HTTP do health-check, URL base do E2E) lê de **Variables e Secrets do repositório GitHub** (`Settings → Secrets and variables → Actions`), com um valor genérico por omissão para continuar a funcionar sem configuração nenhuma:

  | Nome | Tipo | Omissão |
  | --- | --- | --- |
  | `CI_E2E_POSTGRES_DB` | Variable | `ci_e2e` |
  | `CI_E2E_POSTGRES_USER` | Variable | `ci_e2e` |
  | `CI_E2E_POSTGRES_PASSWORD` | Secret | `ci-e2e-password` |
  | `CI_E2E_JWT_SECRET` | Secret | `ci-e2e-jwt-secret-key-with-at-least-32-bytes` |
  | `CI_E2E_JWT_ISSUER` / `CI_E2E_JWT_AUDIENCE` | Variable | `ci-e2e` |
  | `CI_E2E_ADMIN_EMAIL` | Variable | `e2e-admin@example.test` |
  | `CI_E2E_ADMIN_PASSWORD` | Secret | `E2e-admin-password-123` |
  | `CI_E2E_SMTP_SERVER` / `_PORT` / `_SENDER_EMAIL` / `_SENDER_NAME` / `_USERNAME` / `_ENABLE_SSL` | Variable | ver template |
  | `CI_E2E_SMTP_PASSWORD` | Secret | `ci-e2e-email-password` |
  | `CI_E2E_FIREBASE_PROJECT_ID` | Variable | vazio |
  | `CI_E2E_BASE_URL` | Variable | `http://localhost:8080` |
  | `CI_E2E_MIGRATE_SERVICE` | Variable | `migrate` (nome do serviço no `docker-compose`) |
  | `CI_E2E_HEALTHCHECK_PATH` | Variable | `/health` |
  | `CI_E2E_HEALTHCHECK_STATUS` | Variable | `200` |

  Um projeto real (ex. GameSphere) configura estas Variables/Secrets uma vez — sem nunca editar o `ci.yml` gerado nem este pacote precisar de saber nada específico do projeto. Só é preciso definir as que queres substituir à omissão; as restantes ficam com o valor genérico da tabela.

  **Pela aplicação do GitHub:**

  1. No repositório, abre **Settings → Secrets and variables → Actions**.
  2. Para um valor não sensível (ex. `CI_E2E_HEALTHCHECK_PATH`): separador **Variables** → **New repository variable** → nome (`CI_E2E_HEALTHCHECK_PATH`) e valor (`/api/quizzes`) → **Add variable**.
  3. Para um valor sensível (ex. `CI_E2E_JWT_SECRET`): separador **Secrets** → **New repository secret** → nome e valor → **Add secret**.
  4. Repete para cada nome da tabela que precises de substituir. Não é preciso recorrer nem alterar nada no workflow — o próximo push já lê os valores novos.

  **Pelo `gh` CLI:**

  ```bash
  # Variables (não sensíveis) — o valor fica visível em `gh variable list`
  gh variable set CI_E2E_HEALTHCHECK_PATH --body "/api/quizzes"
  gh variable set CI_E2E_HEALTHCHECK_STATUS --body "401"
  gh variable set CI_E2E_FIREBASE_PROJECT_ID --body "gamesphere-9f7dc"

  # Secrets — sem --body, o gh pede o valor de forma interativa (não fica no histórico da shell)
  gh secret set CI_E2E_JWT_SECRET
  gh secret set CI_E2E_POSTGRES_PASSWORD
  ```

  Confirmar o que ficou definido: `gh variable list` e `gh secret list` (este último só mostra os nomes — o GitHub nunca devolve o valor de um secret depois de guardado).

* **Extensão futura**: cada template específico vive em `templates/ci/<nome>.yml` com placeholders `{{CHAVE}}` (citados em YAML sempre que o placeholder é o primeiro carácter do valor, ex. `"{{FRONTEND_DIR}}"`, para não serem lidos como *flow mapping*) — reservados a factos estruturais do repositório (caminhos, nomes de ficheiros), nunca a segredos ou configuração da aplicação, que seguem o padrão `vars`/`secrets` acima. Cada template tem uma função de deteção própria em `bin/install.js` e uma entrada na lista `SPECIFIC_CI_TEMPLATES`; novas combinações de stacks entram por este mecanismo, sem alterar o template genérico.

### Evitar execuções duplicadas de CI

Um padrão comum causa um bug silencioso: se um workflow de CI disparar em `push` para `main` **e** `dev`, um merge por fast-forward de `dev` para `main` empurra o **mesmo commit SHA** para as duas branches. Como o workflow escuta `push` nas duas, o GitHub dispara uma execução completa por cada branch atualizada — testando duas vezes o mesmo commit.

O instalador copia sempre `.github/actions/skip-duplicate-run/action.yml`, uma extensão que envolve a [`fkirc/skip-duplicate-actions`](https://github.com/fkirc/skip-duplicate-actions) e deteta quando o commit atual já teve uma execução bem-sucedida deste workflow. O `ci.yml` gerado (acima) já a usa automaticamente. Se o teu projeto tiver uma stack fora de Node/Gradle/Flutter e por isso não receber o `ci.yml` gerado, podes referenciá-la manualmente no teu próprio workflow:

```yaml
jobs:
  pre_job:
    runs-on: ubuntu-latest
    outputs:
      should_skip: ${{ steps.skip.outputs.should_skip }}
    steps:
      - id: skip
        uses: ./.github/actions/skip-duplicate-run

  backend:
    needs: pre_job
    if: needs.pre_job.outputs.should_skip != 'true'
    runs-on: ubuntu-latest
    steps:
      # ...
```

Só é preciso aplicar `needs: pre_job` + a condição `if` aos jobs que arrancam diretamente do evento (sem outro job como dependência) — jobs que já dependem desses via `needs` saltam em cascata automaticamente. Eventos `pull_request`, `workflow_dispatch`, `schedule` e `merge_group` nunca são saltados.

## Instalação noutro repositório

Este pacote não está publicado no registo npm (`"private": true`) — corre-se diretamente a partir do repositório GitHub, dentro da raiz do repositório onde o queres aplicar (tem de já ser um repositório git):

```bash
npx github:Leo96s/automatic-version-control
```

O instalador (`bin/install.js`):

* Copia sempre para o repositório de destino `.github/workflows/versioning.yml` (workflow genérico gerido por este pacote — é sempre substituído pela versão mais recente ao voltar a correr o instalador)
* Copia sempre `.github/actions/skip-duplicate-run/action.yml` (ver [Evitar execuções duplicadas de CI](#evitar-execuções-duplicadas-de-ci)) — um ficheiro estático que só tem efeito se estiver referenciado por um workflow, seja o `ci.yml` gerado (ver abaixo) ou um workflow teu
* Grava o commit SHA deste pacote instalado em `.github/automatic-version-control.version` — permite a uma ferramenta externa (ex. um hook local) saber se o repositório está desatualizado sem ter de comparar conteúdo de ficheiros
* Deteta se o repositório é um projeto **Gradle/Kotlin** ou **Flutter** (mesma lógica descrita em [Build + release de APK](#build--release-de-apk-kotlinflutter)) e só nesse caso copia também `.github/workflows/mobile-release.yml` — noutros repositórios (Node, etc.) esse workflow nem chega a ser instalado, para não ficar lá um workflow morto a correr sem fazer nada em cada release
* **Se detetar um projeto .NET com testes + frontend Node + Docker Compose, um script `test` num `package.json` (raiz ou subpasta de primeiro nível), ou um projeto Gradle/Kotlin ou Flutter**: gera `.github/workflows/ci.yml`, a partir do template específico correspondente ou do genérico (ver [Testes automáticos de CI](#testes-automáticos-de-ci-ciyml)) — **substituindo sempre qualquer `ci.yml` já existente**, incluindo um escrito à mão
* **Se detetar metadados de plugin**: copia apenas nesses projetos a extensão `.github/actions/plugin-version-sync/action.yml` e o helper `scripts/sync-plugin-versions.js`; o workflow genérico chama a extensão no mesmo job do release
* **Se detetar `package-lock.json` ou `npm-shrinkwrap.json` rastreado pelo Git**: copia `.github/workflows/npm-audit.yml` e `scripts/npm-audit.js`, que fazem a auditoria periódica das dependências e notificam através de um Issue do GitHub (inclui locks em subpastas de monorepos; ignora `.git` e `node_modules`)
* **Se o repositório tiver `package.json`**: copia também `commitlint.config.js`, `.secretlintrc.json`, `.lintstagedrc.json` e `scripts/pre-commit-checks.js`; garante que `node_modules/` está no `.gitignore`; adiciona as devDependencies necessárias e o script `prepare` ao `package.json` (encadeando com um `prepare` já existente, se houver); corre `npm install`; configura os hooks do Husky (`commit-msg` e `pre-commit`; se já existir um `pre-commit` personalizado, não o substitui — mostra a instrução para o adicionares manualmente)
* **Se não tiver `package.json`** (caso comum em repositórios Kotlin/Android ou Flutter puros): salta toda a parte de tooling local em Node acima; instala os workflows de CI aplicáveis e, se detetar metadados de plugin, também a extensão e o helper de sincronização, que correm no runner do GitHub Actions e não exigem Node local no repositório

### Depois de instalar

No repositório de destino, em **Settings → Actions → General**:

* **Workflow permissions** → `Read and write permissions`
* **Actions permissions** → `Allow all actions and reusable workflows`

O workflow de auditoria necessita que a funcionalidade **Issues** esteja ativa no repositório. A permissão `issues: write` é declarada no próprio workflow; não são necessárias secrets adicionais.

Sem isto, o workflow não consegue fazer push de tags/commits nem criar Releases.

## Build + release de APK (Kotlin/Flutter)

O instalador só copia `.github/workflows/mobile-release.yml` para repositórios onde deteta, na raiz ou numa subpasta de primeiro nível, um projeto **Gradle/Kotlin** (`gradlew` + `settings.gradle[.kts]`) ou **Flutter** (`pubspec.yaml` com secção `flutter:` + pasta `android/`) — noutro tipo de repositório, este workflow nem é instalado.

Quando instalado, arranca sempre que o `versioning.yml` termina com sucesso (`workflow_run`, não `push: tags:` — um push de tag feito com o `GITHUB_TOKEN` por omissão, como o que o `versioning.yml` faz, nunca dispara outros workflows, é uma proteção do GitHub Actions contra ciclos infinitos), vai buscar sozinho a tag mais recente à branch, e:

1. Confirma o tipo de projeto e a pasta outra vez (deteção barata, repetida como rede de segurança).
2. Salta tudo o resto se a Release da tag já tiver um `.apk` anexado (idempotência — o `workflow_run` pode disparar mais do que uma vez), **ou** se nada mudou dentro da pasta do projeto mobile desde a tag anterior (ex. um commit `docs:`/`ci:` que só mexeu noutra parte do repositório não gera um APK novo).
3. Compila um APK de release assinado (`./gradlew assembleRelease` para Gradle/Kotlin, `flutter build apk --release` para Flutter) e anexa-o à GitHub Release da tag (a que o `versioning.yml` já cria, ou uma nova se ainda não existir).

### Secrets necessárias (Settings → Secrets and variables → Actions)

| Secret | Obrigatória | Descrição |
| --- | --- | --- |
| `MOBILE_KEYSTORE_BASE64` | Sim | `base64 -w0 caminho/para/a/keystore.jks` da keystore de release |
| `MOBILE_KEYSTORE_STORE_PASSWORD` | Sim | Password da keystore |
| `MOBILE_KEYSTORE_KEY_PASSWORD` | Sim | Password da chave (alias `upload`, fixo) |
| `MOBILE_GOOGLE_SERVICES_JSON_BASE64` | Não | `base64 -w0 google-services.json`, só se o projeto usar Firebase |

### Contrato que o projeto de destino tem de cumprir

* **Gradle/Kotlin**: o `signingConfig` de release do `build.gradle.kts` tem de ler `KEYSTORE_PATH`, `STORE_PASSWORD` e `KEY_PASSWORD` de variáveis de ambiente (não de um ficheiro `local.properties` ou valores fixos no código).
* **Flutter**: o `android/app/build.gradle(.kts)` tem de ter um `signingConfigs.release` que lê `android/key.properties` (`storePassword`, `keyPassword`, `keyAlias`, `storeFile`) — este workflow escreve esse ficheiro a partir das secrets antes de compilar, mas não cria o `signingConfigs.release` em si; sem ele, o build de release continua a usar a assinatura de debug por omissão do template do Flutter.

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
├── .github/workflows/versioning.yml  # workflow genérico de versionamento semântico
├── .github/workflows/npm-audit.yml    # auditoria npm + notificação por Issue
├── .github/actions/plugin-version-sync/action.yml # extensão de plugins, instalada condicionalmente
├── .github/actions/skip-duplicate-run/action.yml # evita CI duplicado, copiado sempre
├── .github/workflows/ci.yml           # template genérico (Node/Gradle/Flutter), instalado condicionalmente
├── templates/ci/dotnet-node-docker-e2e.yml # template específico .NET+Node+Docker E2E, com placeholders
├── .github/workflows/mobile-release.yml # build + release de APK (Kotlin/Flutter)
├── scripts/npm-audit.js               # descoberta e normalização dos resultados npm audit
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
