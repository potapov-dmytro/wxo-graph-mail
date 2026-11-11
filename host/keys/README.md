# Keys

This folder holds the keys for embedded chat security (README, Step 3). Its contents are git-ignored except for this file.

Expected files:

- `jwtRS256.key`: your private key (generated with `openssl`, never share it)
- `jwtRS256.key.pub`: your public key (paste it into the wxO embedded chat security settings)
- `ibmPublic.key.pub`: the IBM provided public key (copied from the same settings page)
