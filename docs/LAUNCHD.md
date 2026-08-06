# LAUNCHD — A Ordem dos Serviços (LAB-8GB)

> Regra de ouro: **antes de tocar em qualquer serviço, ler `docs/AUDIT.md`**.
> Este documento é o mapa de quem roda onde, qual config é canônica e o que
> nunca pode ser tocado. Atualizado em 2026-08-06 após a consolidação dos
> cloudflared duplicados.

## 1. Política de domínio

| Domínio | Uso | Onde vive o plist |
|---|---|---|
| `system` (LaunchDaemons) | Infra que precisa subir no boot, sem sessão do usuário: túneis, bridges, daemons de rede | `/Library/LaunchDaemons` |
| `gui/<uid>` (LaunchAgents) | Apps de sessão: gateway, UIs, Home Assistant, runtimes que dependem do usuário logado | `~/Library/LaunchAgents` |
| `disabled/` | Plists aposentados — **nunca deletar**, mover para cá | `~/Library/LaunchAgents/disabled/` |

**Decisão 2026-08-06:** túneis cloudflared rodam **só no domínio system**.
Tinha 6 processos cloudflared, com o túnel principal e o túnel SSH rodando
**em duplicidade** (user agent + system daemon ao mesmo tempo, 8 conexões no
edge, metade com config velha em memória → 404 intermitente no
`inference.minilab.work`). User agents aposentados; sobrou 1 processo por túnel.

## 2. Fonte única de config dos túneis

| Túnel | ID | Daemon | Config canônica |
|---|---|---|---|
| Principal (UIs + inference) | `2b7bc384-08ec-4fda-9c54-cd509ac3c578` | `work.minilab.cloudflared` (system) | `/etc/cloudflared/config.yml` |
| SSH 8GB | ssh8gb | `com.minilab.cloudflared-ssh` (system) | `~/.cloudflared/ssh8gb.yml` |
| lab-8gb-inference (remotely managed) | `92c0ee9b-d899-4c40-b8ae-1ca02956df39` | `com.cloudflare.cloudflared` (system) | token (dashboard) |
| cloudflare-os-tunnel | — | `com.danvoulez.cloudflare-os-tunnel` (gui) | projeto Cloudflare-OS |

- O drift velho de `/etc/cloudflared/config.yml` (hostnames aposentados:
  tv.logline.world, lab8gb-runtime, passport, ingress, work-8gb) foi
  substituído pela config canônica do HOME. Backup do drift:
  `/etc/cloudflared/config.yml.bak-golden-20260806`.
- `~/.cloudflared/config.yml` agora é **legado** — o daemon system lê de
  `/etc`. Mudanças de ingress: editar `/etc/cloudflared/config.yml`,
  `cloudflared tunnel ingress validate`, `sudo launchctl kickstart -k system/work.minilab.cloudflared`.
- Credentials do túnel principal no system: `/etc/cloudflared/2b7bc384-....json`.

## 3. Convenção de nomes

- **`com.minilab.*`** — prefixo atual, usar em serviços novos.
- **`work.minilab.*`**, **`local.*`**, **`com.danvoulez.*`** — legados. Não
  renomear por renomear; migrar o nome só quando tocar o serviço por outro
  motivo, e atualizar este doc.

## 4. Inventário classificado

### ⛔ PROTEGIDO — não mexer, nem restart, nem "só pra testar"
| Serviço | Domínio | Motivo |
|---|---|---|
| `com.project-manhattan.agent` | gui | Ordem explícita do dono (2026-08-06) |
| `com.project-manhattan.daemon` | system | Ordem explícita do dono (2026-08-06) |

### 🟢 CORE — Golden Bridge (provider de inferência)
| Serviço | Domínio | O que é |
|---|---|---|
| `local.lab-mistral-gateway` | gui | Gateway/middleware Golden Bridge, bind 0.0.0.0:8787 |
| `com.m1.llm-runtime` | gui | Inferência local qwen2.5-3b, 127.0.0.1:8392 |
| `work.minilab.cloudflared` | system | Túnel principal → `inference.minilab.work` |
| `com.minilab.cloudflared-ssh` | system | Túnel SSH (ssh8gb) |
| `com.cloudflare.cloudflared` | system | Túnel lab-8gb-inference (remotely managed, token) |
| `com.minilab.mistralrs-serve` | LAB-512 | Inferência Mistral Nemo Q4, 10.88.0.10:1234 (cabo) |

### 🔵 INFRA LAB
| Serviço | Domínio | O que é |
|---|---|---|
| `com.minilab.homeassistant` | gui | Home Assistant Core 2026.2.3 (venv uv), :8123 |
| `com.minilab.carbon-control-plane` | gui | Carbon Lab control plane (:8789 API) |
| `com.minilab.carbon-clock` | gui | Carbon clock |
| `com.minilab.control-ui` | gui | control.minilab.work UI (:4173) |
| `com.danvoulez.cloudflare-os-tunnel` | gui | Túnel do projeto Cloudflare-OS |
| `com.logline.registry-shadow` | gui | Logline registry |
| `homebrew.mxcl.postgresql@15` | gui | Postgres |

### 🟡 LEGADO / AVALIAR — não tocar sem aprovação explícita
| Serviço | Domínio | Situação |
|---|---|---|
| `work.minilab.mistral-bus-bridge` | system | Forward python `127.0.0.1:1235 → 10.88.0.10:1234` (`/opt/ubl/bus/bus_bridge.py`). **Candidato a aposentar**: o gateway fala direto com o 512 pelo cabo. Só aposentar depois de confirmar que nada consome a porta 1235. |
| `com.logline.registry-operations` | gui | Carrega mas sai com código 1. Diagnóstico pendente. |

### ⚪ DRIFT CONHECIDO — plist existe mas não carregado
| Plist | Situação |
|---|---|
| `ai.openclaw.gateway` | Plist presente, serviço não carregado. AUDIT.md manda não remover sem aprovação explícita. |
| `com.minilab.cloudflared-main` | **Aposentado 2026-08-06** → `disabled/` (duplicata do túnel principal) |
| `com.minilab.cloudflared-ssh8gb` | **Aposentado 2026-08-06** → `disabled/` (duplicata do túnel SSH) |

## 5. Procedimento para mexer em qualquer serviço

1. Ler `docs/AUDIT.md` e checar a classificação acima.
2. `launchctl print <domínio>/<label>` antes de qualquer ação.
3. Mudança de config → backup com sufixo `.bak-<contexto>-<data>`.
4. Restart sempre com `launchctl kickstart -k <domínio>/<label>`.
5. Aposentar = `bootout` + mover plist para `disabled/`. Nunca `rm`.
6. Verificar o endpoint real depois (não só o processo).
7. Atualizar este doc no mesmo commit.
