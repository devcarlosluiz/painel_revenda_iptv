# Deploy na Oracle Cloud (OCI)

O painel roda como serviço `systemd` na VM, escutando em `0.0.0.0:8080`.
O script [`deploy/install.sh`](deploy/install.sh) faz tudo: Node, código, `.env`,
banco, importação da lista, serviço e firewall do sistema.

---

## Passo 1 — publicar o código no GitHub

A VM instala clonando o repositório, então o que estiver só na sua máquina não chega lá.

```powershell
git add .
git commit -m "deploy: script de instalacao na OCI"
git push origin main
```

## Passo 2 — liberar a porta 8080 no console da Oracle

**Este passo não dá para automatizar pelo script** e é o motivo mais comum de "o IP não
responde": a OCI bloqueia tudo por padrão na borda da rede, antes de chegar na VM.

1. Console da OCI → **Networking → Virtual Cloud Networks** → sua VCN
2. **Subnets** → a subnet da instância → **Security Lists** → a lista default
3. **Add Ingress Rules**:

   | Campo | Valor |
   |---|---|
   | Stateless | Não |
   | Source Type | CIDR |
   | Source CIDR | `0.0.0.0/0` |
   | IP Protocol | TCP |
   | Destination Port Range | `8080` |

Se a instância usa **Network Security Group** em vez de Security List, a regra vai no NSG.

> Aproveite e confirme o **IP público real** da instância nessa mesma tela
> (Compute → Instances → sua instância → *Public IP address*). O script detecta esse IP
> sozinho pelo serviço de metadata da OCI, então você não precisa digitá-lo.

## Passo 3 — rodar o instalador na VM

```bash
ssh -i ~/.ssh/sua-chave.key opc@SEU-IP        # Oracle Linux
# ou:  ssh -i ~/.ssh/sua-chave.key ubuntu@SEU-IP

sudo dnf install -y git      # Oracle Linux   (no Ubuntu: sudo apt install -y git)
git clone https://github.com/devcarlosluiz/clm_painel_iptv.git /tmp/clm
sudo bash /tmp/clm/deploy/install.sh
```

O script é idempotente — pode rodar de novo à vontade. No fim ele imprime a URL do painel
e a senha do admin gerada.

**Variáveis opcionais:**

```bash
PUBLIC_IP=tv.meudominio.com.br sudo bash deploy/install.sh   # usar domínio no lugar do IP
PORT=80 sudo bash deploy/install.sh                          # outra porta
APP_DIR=/srv/iptv sudo bash deploy/install.sh                # outro diretório
```

## Passo 4 — conferir

```bash
systemctl status clm-iptv
journalctl -u clm-iptv -f
curl -s localhost:8080/healthz
```

E do seu computador: `http://SEU-IP:8080/painel/`

---

## Atualizar depois de mexer no código

```powershell
git push origin main          # na sua máquina
```

```bash
sudo bash /opt/clm-iptv/deploy/install.sh    # na VM: faz git pull + restart
```

Ou, para um restart simples sem atualizar nada:

```bash
sudo systemctl restart clm-iptv
```

---

## Quando o IP público não responde

Confira nesta ordem — cada etapa elimina uma camada:

| Teste | Onde rodar | Se falhar |
|---|---|---|
| `curl localhost:8080/healthz` | na VM | o serviço está fora: `journalctl -u clm-iptv -n 50` |
| `sudo iptables -L INPUT -n \| grep 8080` | na VM | firewall do SO: rode o `install.sh` de novo |
| `curl http://SEU-IP:8080/healthz` | na sua máquina | falta a regra de ingress no Security List / NSG (passo 2) |

Timeout na conexão (e não "connection refused") quase sempre significa que a regra de
ingress da OCI está faltando — o pacote nem chega na VM.

---

## HTTPS com domínio

Com Nginx + certbot na frente, o painel escuta só em localhost:

```bash
# no .env da VM
HOST=127.0.0.1
PUBLIC_URL=https://tv.seudominio.com.br
sudo systemctl restart clm-iptv
```

A configuração do Nginx está na seção 7 do [README.md](README.md).
Nesse caso a porta liberada no NSG passa a ser a 443 (e a 80 para o certbot).
