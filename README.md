# Busy Checker

Extensão de navegador + backend que responde "fulano tá livre?" combinando:
- presença ao vivo (mouse/teclado/scroll detectados pela extensão de quem instalou)
- Google Agenda (FreeBusy + título da reunião quando acessível)
- `gpt-4o-mini` pra interpretar a pergunta e formatar a resposta

## Arquitetura

```
┌─────────────┐  activity        ┌─────────────────────┐
│ content.ts  │ ───────────────► │ background.ts (SW)  │
│ (cada aba)  │                  │                     │
└─────────────┘                  │  - OAuth Google     │
                                 │  - heartbeat dedupe │
┌─────────────┐  msg "query"     │  - proxy /query     │
│ popup.ts    │ ───────────────► │                     │
└─────────────┘                  └──────────┬──────────┘
                                            │ Bearer JWT
                                            ▼
                          ┌─────────────────────────────────┐
                          │ backend (Express + TS)          │
                          │  /auth/google/callback          │
                          │  /heartbeat                     │
                          │  /query  ──► gpt-4o-mini        │
                          │           ──► Google Calendar   │
                          │           ──► Postgres          │
                          └─────────────────────────────────┘
```

Só funciona pra pessoas que **também** instalaram a extensão (a parte de presença) — o Calendar é consultado mesmo sem isso, desde que estejam no mesmo Workspace.

## Setup

### 1. Postgres

```bash
createdb busy_checker
# ou via docker:
# docker run -d --name busy-pg -e POSTGRES_USER=busy -e POSTGRES_PASSWORD=busy -e POSTGRES_DB=busy_checker -p 5432:5432 postgres:16
```

### 2. Google Cloud OAuth

1. Console: https://console.cloud.google.com/apis/credentials
2. **Create credentials → OAuth client ID → Web application**
3. Authorized redirect URI: `https://<EXTENSION_ID>.chromiumapp.org/`
   - Pra descobrir o `EXTENSION_ID`: carregue a extensão unpacked uma vez (passo 4) e copie o ID da página `chrome://extensions`.
4. Anote `client_id` e `client_secret`.
5. Em **APIs & Services → Library**, habilite **Google Calendar API**.
6. Em **OAuth consent screen**, configure como Internal (Workspace) e adicione os escopos:
   - `openid`, `email`, `profile`
   - `https://www.googleapis.com/auth/calendar.readonly`

### 3. Backend

```bash
cd backend
cp .env.example .env
# edite .env com:
#   - DATABASE_URL
#   - GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REDIRECT_URI
#   - OPENAI_API_KEY
#   - SESSION_JWT_SECRET (qualquer string longa aleatória)
#   - CORS_ORIGINS=chrome-extension://<EXTENSION_ID>
#   - ALLOWED_HD=suaempresa.com (opcional, restringe login ao domínio)

npm install
npm run db:init
npm run dev
```

Backend sobe em `http://localhost:8787`.

### 4. Extensão

```bash
cd extension
npm install
npm run build
```

Depois:
1. Abra `chrome://extensions`, ligue **Developer mode**.
2. **Load unpacked** → aponte pra `extension/dist`.
3. Copie o **Extension ID** que aparece.
4. Atualize:
   - `backend/.env`: `GOOGLE_REDIRECT_URI=https://<ID>.chromiumapp.org/` e `CORS_ORIGINS=chrome-extension://<ID>`
   - Google Cloud Console: authorized redirect URI com o mesmo `https://<ID>.chromiumapp.org/`
5. Reinicie o backend (`npm run dev` de novo).
6. Configure o client ID na extensão. No console do service worker (chrome://extensions → "service worker"):
   ```js
   chrome.storage.local.set({ config: { googleClientId: "SEU_CLIENT_ID.apps.googleusercontent.com" } })
   ```
7. Clique no ícone → **Entrar com Google** → aceite o consentimento.
8. Pergunte alguma coisa.

## Como testar sem deploy

- Backend roda local; extensão fala com `http://localhost:8787`.
- Pra testar presença de OUTRA pessoa sem 2 máquinas: instale a extensão em dois perfis do Chrome, faça login com contas diferentes do mesmo Workspace.
- Pra testar só o Calendar sem presença: pergunte sobre alguém que esteja em reunião agora — `online` virá `false`, mas `meeting.busy=true` com horário e (se acessível) título.

## Próximos passos

- UI: substituir o popup cru por algo com animação do bicho pensando.
- Diretório: hoje a pergunta precisa conter um email. Adicionar resolução nome → email (provavelmente Admin SDK Directory API, escopo extra).
- Refresh de status: hoje cada `/query` consulta tudo on-demand. Pra time grande, cachear FreeBusy por ~30s.
- Telemetria de quanto cada `/query` custa em tokens da OpenAI.
