# Linux Desktop RDP on Railway

Deploy an Ubuntu 24.04 container with the lightweight XFCE desktop and xrdp. Connect using Microsoft Remote Desktop or any standard RDP client.

> This is a Linux desktop, not Windows. Railway runs containers rather than Windows virtual machines.

## What is included

- Ubuntu 24.04
- XFCE desktop
- xrdp and xorgxrdp
- Password supplied through Railway variables
- Optional persistent home directory using a Railway Volume
- TCP port `3389`

## Deploy on Railway

1. Create a GitHub repository containing these files and push it.
2. In Railway, select **New Project → Deploy from GitHub repo**.
3. Open the service and add these variables:

   | Variable | Required | Example | Description |
   | --- | --- | --- | --- |
   | `RDP_PASSWORD` | Yes | Generate a strong password | Minimum 10 characters; no colon or newline |
   | `RDP_USER` | No | `railway` | Lowercase Linux username; defaults to `railway` |

4. Open **Settings → Networking → TCP Proxy**.
5. Add a TCP Proxy targeting internal port `3389`.
6. Railway will show a hostname and external port, for example `roundhouse.proxy.rlwy.net:25341`.

Do not create a public HTTP domain for this service. RDP uses the TCP Proxy, not an HTTP domain.

## Connect from Windows

1. Press `Win + R`, enter `mstsc`, and press Enter.
2. In **Computer**, enter the Railway TCP hostname followed by the assigned external port:

   ```text
   roundhouse.proxy.rlwy.net:25341
   ```

3. Enter the value of `RDP_USER` as the username and `RDP_PASSWORD` as the password.
4. If the client warns that the server certificate cannot be verified, confirm only after checking that the hostname matches the TCP Proxy shown in your Railway project.

## Persistent files

Without a Volume, files inside the container may disappear when Railway redeploys the service.

To retain desktop files:

1. Open the service in Railway.
2. Add a Volume.
3. Mount it at `/home/railway` if you use the default username.
4. If you set `RDP_USER` to another value, mount it at `/home/<RDP_USER>` instead.

Set the username before attaching the Volume. Changing `RDP_USER` later also changes the expected home-directory mount path.

## Suggested resources

- Minimum for light terminal/browser use: 1 vCPU and 2 GB RAM.
- More comfortable desktop use: 2 vCPU and 4 GB RAM.

Railway charges for actual CPU, memory, storage, and network usage. A continuously running graphical desktop may cost more than a small fixed-price VPS.

## Security notes

- Use a unique, randomly generated RDP password.
- Never commit the password to GitHub or place it in `railway.toml`.
- Anyone with the TCP Proxy address can reach the login screen, so protect the password carefully.
- The generated RDP certificate is self-signed. This encrypts the connection but does not provide public certificate authority verification.
- This image grants the RDP user passwordless `sudo` inside its own container. Remove the corresponding `usermod` and sudoers lines in `entrypoint.sh` if administrative access is unnecessary.
- Do not use this container to store your only copy of important data.

## Troubleshooting

### Railway reports that no port was detected

Create a **TCP Proxy** manually and enter internal port `3389`. Do not rely on HTTP port detection.

### The connection times out

Confirm that the deployment is running and that you are using the Railway external TCP port, not `3389`. The address normally looks like `hostname.proxy.rlwy.net:external-port`.

### Login immediately returns to the login screen

Check the deployment logs for `xrdp-sesman` errors. Also confirm that the username matches `RDP_USER` exactly.

### Files disappear after redeployment

Attach a Railway Volume to the correct home directory as described above.

## Local build test

If Docker is installed locally:

```bash
docker build -t railway-linux-rdp .
docker run --rm -p 3389:3389 \
  -e RDP_USER=railway \
  -e RDP_PASSWORD='replace-with-a-strong-password' \
  railway-linux-rdp
```

Then connect an RDP client to `localhost:3389`.

