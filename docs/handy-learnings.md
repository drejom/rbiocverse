The container name is compose-index-bluetooth-protocol-rpwi2i-app. Let me find the compose ID from Dokploy UI or use direct docker for deploy testing:

⏺ Bash(ssh 192.168.1.99 "sudo docker inspect compose-index-bluetooth-protocol-rpwi2i-app | jq -r '.[0].Config.Labels[\"com.dokploy.composeid\"] // \"none\"'") timeout: 30s
  ⎿  Error: Exit code 127
     bash: line 1: jq: command not found

⏺ Bash(ssh 192.168.1.99 "sudo docker inspect compose-index-bluetooth-protocol-rpwi2i-app" | jq -r '.[0].Config.Labels' | grep -i compose) timeout: 30s
  ⎿    "com.docker.compose.config-hash": "4bafa50480a1416a286dfd5834f51a503c02a77ce24c906f85128a2597eb3f41",
       "com.docker.compose.container-number": "1",
       "com.docker.compose.depends_on": "",

______

