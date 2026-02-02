**Descrição do Projeto**

Este projeto implementa um sistema de **versionamento semântico automático** baseado em mensagens de commit, utilizando GitHub Actions. A cada alteração enviada para as branches principais, o workflow analisa o histórico de commits e:

* Incrementa a versão seguindo o padrão **Semantic Versioning (SemVer)**
* Cria **tags retroativas** no commit correto
* Atualiza automaticamente o **package.json** e **package-lock.json** (mesmo em subpastas)
* Gera e mantém atualizados os ficheiros **CHANGELOG.md** e **RELEASE_NOTES.md**
* Ignora commits de merge, commits do bot e mensagens sem prefixos semânticos

O sistema suporta commits feitos fora das branches controladas e reconstrói corretamente o histórico de versões quando estes são integrados, garantindo um controlo de versões consistente, automatizado e confiável.

---
