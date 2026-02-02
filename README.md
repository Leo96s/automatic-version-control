**Project Description**

This project implements an **automatic semantic versioning** system based on commit messages, using GitHub Actions. With each change sent to the main branches, the workflow analyses the commit history and:

* Increments the version following the **Semantic Versioning (SemVer)** standard
* Creates **retroactive tags** on the correct commit
* Automatically updates **package.json** and **package-lock.json** (even in subfolders)
* Generates and keeps **CHANGELOG.md** and **RELEASE_NOTES.md** files up to date
* Ignores merge commits, bot commits, and messages without semantic prefixes

The system supports commits made outside of controlled branches and correctly reconstructs the version history when they are integrated, ensuring consistent, automated, and reliable version control.


---
