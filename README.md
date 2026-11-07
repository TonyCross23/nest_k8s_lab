# NestJS Todo CRUD

A small Todo REST API built with NestJS, Zod, PostgreSQL, and Prisma. Run it locally, with Docker Compose, or on a local Kubernetes cluster using Minikube.

Start with [Docker Compose](#docker-compose-quick-start) for a quick run, follow the [Kubernetes walkthrough](#kubernetes-beginner-walkthrough) to learn Minikube, or jump to the [curl examples](#crud-endpoints).

## Requirements

| Workflow | Tools |
| --- | --- |
| Docker Compose | Docker Engine and Docker Compose |
| Local development | Node.js 24.15+ and npm, plus PostgreSQL or Docker |
| Kubernetes | Docker Engine, Minikube, kubectl, Bash, and Python 3 |
| Integration tests | Node.js and a running API with a test database |

The database credentials in this repository are local learning examples. Change credentials and add authentication before exposing the API publicly.

## Docker Compose quick start

Run these commands from the project root:

```bash
docker compose up --build -d
docker compose ps -a
docker compose logs -f api
```

API URL: `http://localhost:3000/api/todos`.

Compose starts PostgreSQL, waits for its health check, runs Prisma migrations, and then starts the API. No `.env` file is required for this workflow. The `migrate` service exiting with code `0` means its work succeeded. Press `Ctrl+C` to stop following logs; the containers keep running.

```bash
# Stop containers and keep database data.
docker compose down

# Stop containers and delete the database volume and its data.
docker compose down -v
```

## Local development

Run PostgreSQL in Docker and the API directly on your machine:

```bash
cp .env.example .env
npm ci
docker compose up -d db
npm run prisma:generate
npm run db:deploy
npm run start:dev
```

If the Compose API is already using port 3000, run `docker compose stop api` first. If you use another PostgreSQL instance, update `DATABASE_URL` in `.env`.

After changing `prisma/schema.prisma`, create a migration:

```bash
npm run db:migrate -- --name describe_change
```

Commit the generated migration SQL with the application. Prisma 7 reads its CLI connection URL from `prisma.config.ts`; the running application uses `@prisma/adapter-pg`.

## Kubernetes: beginner walkthrough

### 1. Understand what will run

| Resource | Name | Purpose |
| --- | --- | --- |
| Namespace | `nest-crud` | Groups this application's resources |
| Secret | `app-secret` | Supplies local database credentials and `DATABASE_URL` |
| PersistentVolumeClaim (PVC) | `postgres-storage` | Requests 1Gi of persistent database storage |
| Deployment | `postgres` | Maintains one PostgreSQL Pod |
| Service | `postgres-service` | Gives the database a stable name and port inside the cluster |
| Deployment | `nest-api` | Maintains one NestJS API Pod |
| Service | `nest-api-service` | Exposes API port 3000 as a NodePort Service |

A **Pod** runs one or more containers. A **Deployment** maintains the requested number of Pods and replaces failed Pods. A **Service** finds Pods by their labels, so callers do not need to know changing Pod IP addresses. A **PVC** provides storage that survives Pod replacement.

Each API Pod starts its containers in this order:

```text
wait-for-postgres -> wait-and-migrate -> api
  pg_isready         Prisma migrate     NestJS
```

These first two containers are **init containers**: each must finish successfully before the next container starts. The database wait retries up to 60 times per attempt; Kubernetes retries a failed init container. Failed migrations prevent the API container from starting.

Requests follow this path:

```text
curl -> local port-forward -> API Pod
                                |
                                v
                         postgres-service:5432
                                |
                                v
                         PostgreSQL Pod -> PVC
```

The API uses `postgres-service` as its database hostname. `localhost` inside the API Pod would refer to that Pod, not to PostgreSQL.

The manifests do not hardcode a namespace. The commands below explicitly select the `nest-crud` context and namespace so the Secret, Services, PVC, and Deployments stay together. Compose and Kubernetes use separate databases.

### 2. Check your folder and tools

Use a terminal on the machine where your Minikube cluster runs. Commands you run on another machine or Docker daemon do not prepare this cluster's images.

Start in the repository root, where the Dockerfile is located. If your prompt ends in `/nest_k8s_lab/k8s`, run `cd ..` first. After pulling these changes from GitHub, check:

```bash
pwd
ls Dockerfile scripts/minikube-images.sh k8s/
docker version
minikube version
kubectl version --client
bash --version
python3 --version
```

Expected: version information from all three tools. `docker version` should include both Client and Server information. Resolve Docker connection or permission errors before continuing.

### 3. Start a local cluster

A cluster is the environment where Kubernetes runs your Pods. Create a dedicated Minikube profile for this application:

```bash
minikube start -p nest-crud \
  --driver=docker \
  --container-runtime=containerd \
  --cpus=2 \
  --memory=3072
```

This allocates two CPUs and 3GiB of memory. The first start may take several minutes while Kubernetes images download.

Check the context and node:

```bash
kubectl config get-contexts
kubectl --context=nest-crud get nodes
```

Expected: the node has `STATUS` equal to `Ready`. A context tells kubectl which cluster to contact. The remaining commands use `--context=nest-crud` explicitly, regardless of which context is currently selected.

Minikube normally enables `storage-provisioner` and `default-storageclass`. Check them if the PVC later remains `Pending`:

```bash
minikube -p nest-crud addons list
```

### 4. Prepare and verify all three images

There are two separate image stores:

| Location | Contains | How to inspect it |
| --- | --- | --- |
| Host Docker | Images built or pulled by your terminal's Docker daemon | `docker image ls` |
| Minikube containerd | Images that Kubernetes can actually start | `minikube -p nest-crud ssh -- "sudo crictl images"` |

An image being present in host Docker does not prove it is present in Minikube. Likewise, `minikube image load --daemon` can report that a host image is missing even when an older copy is already present in the cluster.

Use the image-preparation helper from the repository root:

```bash
bash scripts/minikube-images.sh
```

The helper performs these steps, in order:

1. Checks that host Docker is available and the `nest-crud` profile is running.
2. Reuses existing host images. If an application image is missing, builds it from the correct Dockerfile target. If PostgreSQL is missing, pulls it on the host. Failed builds and pulls are retried up to three times.
3. Exports each host image into a temporary `.tar` archive with `docker image save`.
4. Imports each archive into Minikube. This transfer does not ask the node to contact Docker Hub.
5. Checks that each image exists inside the node and matches the archive's content. A missing image or an older image with the same tag causes the script to stop with an error.
6. Removes the temporary archives, including when a step fails.

The default reuses local images. After changing application code or migrations, use `--rebuild`; see step 10. The helper works even when called from another directory with the correct script path, for example `bash ../scripts/minikube-images.sh` from `k8s/`.

A successful run ends with:

```text
Verified nest-api:latest (sha256:...).
Verified nest-migrate:latest (sha256:...).
Verified postgres:17-bookworm (sha256:...).

All three images verified in Minikube profile nest-crud. Continue with the README namespace and dry-run steps.
```

**Do not continue to deployment if the helper reports an error.** A command returning silently is not proof that an image reached the node. Check the actual runtime if you need to inspect the result:

```bash
minikube -p nest-crud ssh -- "sudo crictl images"
```

`crictl` inspects the container runtime used by Kubernetes. This command runs it inside Minikube; you do not need to install it on your host.

Look for these names and tags; exact IDs and sizes vary:

```text
IMAGE                            TAG
.../nest-api                     latest
.../nest-migrate                 latest
.../postgres                     17-bookworm
```

The API and migration use `imagePullPolicy: Never`. PostgreSQL and its wait container use `IfNotPresent`, so the imported PostgreSQL image is used without a registry pull while it remains cached on the node.

For a different profile, select it explicitly:

```bash
bash scripts/minikube-images.sh --profile YOUR_PROFILE
```

Use that same profile's kubectl context in the later commands. This guide otherwise assumes a single-node, containerd-based profile named `nest-crud`.

#### If you see a TLS handshake timeout

For example:

```text
failed to fetch anonymous token ... auth.docker.io ... TLS handshake timeout
```

This means the component doing the pull could not finish its TLS connection to Docker Hub's authentication service. A host Docker pull and a pull inside the Minikube node use different network paths. The archive workflow avoids the node-side registry request, including when `minikube image pull` did not produce a useful result.

The host still needs registry access for the first PostgreSQL pull and uncached application builds. If the helper stops at that stage, try the failed host operation by itself:

```bash
docker pull postgres:17-bookworm
```

Once that succeeds, rerun the helper. Keep the same Docker context and environment for both commands; `docker context show` identifies the selected context, and `DOCKER_HOST` or `DOCKER_CONTEXT` can override its connection settings. If host pulls keep timing out, resolve the network/VPN/proxy connection to Docker Hub first. Docker daemon proxy configuration is described in the [official Docker guide](https://docs.docker.com/engine/daemon/proxy/).

If only PostgreSQL needs transferring and you want to perform that transfer manually, use a local archive:

```bash
docker image inspect postgres:17-bookworm
docker image save --output /tmp/nest-crud-postgres.tar postgres:17-bookworm
minikube -p nest-crud image load /tmp/nest-crud-postgres.tar --overwrite=true
minikube -p nest-crud ssh -- "sudo crictl inspecti --output table docker.io/library/postgres:17-bookworm"
```

Only run the save command after the host inspect succeeds. Only continue after the node inspect displays the PostgreSQL image. The helper additionally checks that the imported content matches the host archive. You can remove `/tmp/nest-crud-postgres.tar` after a successful import.

### 5. Create a namespace and perform a dry-run

Create the application's namespace:

```bash
kubectl --context=nest-crud create namespace nest-crud
```

If it reports `AlreadyExists`, use the existing namespace and continue.

First, check the manifests without creating application resources:

```bash
kubectl --context=nest-crud -n nest-crud apply --dry-run=client -f k8s/
```

Expected: each resource is reported with a dry-run suffix. Client dry-run checks the generated objects and available schema validation. It may still contact the cluster for API information.

You can also ask the API server to validate the resources without saving them:

```bash
kubectl --context=nest-crud -n nest-crud apply --dry-run=server -f k8s/
```

A dry-run does not start Pods, pull images, run migrations, or prove that the database connection works. The cluster and namespace from earlier steps already exist; the dry-run does not create the application resources.

### 6. Start PostgreSQL and its storage

**Updating an existing installation?** The original manifest used ephemeral storage. Adding a PVC starts PostgreSQL on a new data directory; it does not copy old database data. Back up existing data before applying the storage change. See [Existing database backup and restore](#existing-database-backup-and-restore).

Create the Secret, PVC, database Deployment, and database Service:

```bash
kubectl --context=nest-crud -n nest-crud apply \
  -f k8s/secret.yaml \
  -f k8s/postgres.yaml

kubectl --context=nest-crud -n nest-crud rollout status \
  deployment/postgres --timeout=600s

kubectl --context=nest-crud -n nest-crud get pods,pvc,services
```

Expected: the PostgreSQL Pod becomes `1/1 Running`, and `postgres-storage` becomes `Bound`. `Bound` means Kubernetes assigned storage to the claim.

PostgreSQL mounts the PVC at `/var/lib/postgresql/data` and writes database files into the `pgdata` subdirectory. Its readiness probe checks TCP connectivity using the configured username and database. The Deployment uses `Recreate` so an update stops the previous database Pod before starting its replacement; brief database downtime during an update is expected.

### 7. Start the API and inspect migrations

```bash
kubectl --context=nest-crud -n nest-crud apply -f k8s/api-deployment.yaml

kubectl --context=nest-crud -n nest-crud rollout status \
  deployment/nest-api --timeout=600s
```

The API Pod first waits for PostgreSQL, then runs `npm run db:deploy`, then starts NestJS. The migration runs inside the API Pod, so there is no separate migration Job to inspect.

Read the init-container and API logs:

```bash
kubectl --context=nest-crud -n nest-crud logs deployment/nest-api -c wait-for-postgres
kubectl --context=nest-crud -n nest-crud logs deployment/nest-api -c wait-and-migrate
kubectl --context=nest-crud -n nest-crud logs deployment/nest-api -c api
```

Expected: PostgreSQL accepts connections, Prisma reports successful migrations or no pending migrations, and NestJS starts. The Pod may show `Init:0/2` or `Init:1/2` while initialization is in progress. Once ready, it should show `1/1 Running`.

```bash
kubectl --context=nest-crud -n nest-crud get pods,services,pvc
```

The API readiness probe calls `/api/todos`, which also exercises the database connection. A failed readiness check prevents normal Service traffic from being sent to that Pod.

### 8. Access the API from your machine

Forward a local port to the API Service:

```bash
kubectl --context=nest-crud -n nest-crud port-forward service/nest-api-service 3000:3000
```

Expected: `Forwarding from 127.0.0.1:3000 -> 3000`.

The first number is your machine's port; the second is the Service port. Keep this terminal open. In another terminal:

```bash
curl http://localhost:3000/api/todos
```

Expected: a JSON array, initially `[]` on a fresh database. Use the CRUD examples below to create data.

If Compose or another application already uses port 3000, choose local port 3001:

```bash
kubectl --context=nest-crud -n nest-crud port-forward service/nest-api-service 3001:3000
```

Then use `http://localhost:3001` for curl and tests. Although the Service is a NodePort, port-forwarding gives a predictable localhost URL without depending on the host-to-Minikube network. Kubernetes assigns the NodePort automatically; you can inspect it with `kubectl --context=nest-crud -n nest-crud get service nest-api-service`.

### 9. Test CRUD and database persistence

With port-forwarding running, execute the integration test from the project root:

```bash
npm run test:e2e
```

For local port 3001:

```bash
TEST_API_URL=http://localhost:3001 npm run test:e2e
```

The test creates and removes its own Todo and checks CRUD, validation, and missing-record responses. Use a test database.

To check persistence, create a Todo using the curl examples and remember its returned ID. Replace only the database Pod:

```bash
kubectl --context=nest-crud -n nest-crud delete pod -l app=postgres

kubectl --context=nest-crud -n nest-crud rollout status \
  deployment/postgres --timeout=300s
```

Fetch the Todo again after the database and API are ready. It should still exist because its database files are stored on the PVC. Temporary API failures while PostgreSQL restarts are expected.

### 10. Rebuild after changing code or migrations

Rebuild both application images, import all required images using archives, and verify them:

```bash
bash scripts/minikube-images.sh --rebuild
```

Continue only after `All three images verified` appears. Then update the Deployment and replace the API Pod:

```bash
kubectl --context=nest-crud -n nest-crud apply -f k8s/api-deployment.yaml
kubectl --context=nest-crud -n nest-crud rollout restart deployment/nest-api
kubectl --context=nest-crud -n nest-crud rollout status deployment/nest-api --timeout=600s
```

Applying unchanged YAML does not restart Pods just because an image with the same tag changed. `rollout restart` creates new Pods, which run the init containers and use the imported images. Prisma applies pending migrations and skips already-applied migrations. Existing PostgreSQL data remains on its PVC.

### 11. Troubleshoot a failed deployment

Start with Pod status, events, and logs:

```bash
kubectl --context=nest-crud -n nest-crud get pods,pvc
kubectl --context=nest-crud -n nest-crud get events --sort-by=.metadata.creationTimestamp
kubectl --context=nest-crud -n nest-crud describe deployment nest-api
kubectl --context=nest-crud -n nest-crud logs deployment/postgres
```

To inspect one failing Pod, copy its name from `get pods` and run `kubectl --context=nest-crud -n nest-crud describe pod POD_NAME`.

| Symptom | What to check |
| --- | --- |
| `ErrImageNeverPull` | Run `bash scripts/minikube-images.sh` against the same profile and require all three verification messages before restarting the API. |
| `ImagePullBackOff` | Inspect Pod events. For PostgreSQL registry errors, use the host-to-archive helper, then wait for Kubernetes to retry. |
| `The image ... was not found; unable to add it to cache` | Inspect the image in host Docker. Use the helper's archive transfer instead of `image load --daemon`. |
| `minikube image pull` is silent but PostgreSQL is absent | Inspect the actual runtime with `crictl images` inside the node; use the archive helper and require verification. |
| `auth.docker.io ... TLS handshake timeout` | Identify whether the failure is on the host or node. Use the archive workflow for node-side failures; fix host registry connectivity if the host pull also fails. |
| Helper reports a different image ID after import | Stop deployment. Check import errors, node disk space, and image architecture; rerun the helper. An older tag is not accepted as success. |
| `Pending` PVC | Check the default StorageClass and Minikube storage addons. If disabled, enable `storage-provisioner` and `default-storageclass` with `minikube -p nest-crud addons enable ADDON_NAME`. |
| `CreateContainerConfigError` | Check that `app-secret` and its required keys exist in the same namespace. |
| `Init:0/2` | Read `wait-for-postgres` logs; check the database Pod and `postgres-service`. |
| `Init:1/2` or `Init:CrashLoopBackOff` | Read both init-container logs to identify whether database waiting or migration failed. For a restarted container, add `--previous` to its logs command. |
| API `CrashLoopBackOff` | Read API container logs with `-c api`; verify `DATABASE_URL` and successful migrations. |
| API `0/1 Running` | Readiness has not passed yet. Check API logs and database availability. |
| Local port already in use | Forward `3001:3000` and use port 3001 in curl and tests. |
| Connection refused to the Kubernetes API | Check `minikube -p nest-crud status` and the `nest-crud` context. |

### 12. Stop or remove the application

Press `Ctrl+C` in the port-forward terminal to close the local connection. This does not stop the Pods.

Stop the Minikube cluster while retaining its local storage:

```bash
minikube -p nest-crud stop
```

Resume it later:

```bash
minikube start -p nest-crud
```

To remove application workloads while retaining the PVC:

```bash
kubectl --context=nest-crud -n nest-crud delete deployment nest-api postgres
kubectl --context=nest-crud -n nest-crud delete service nest-api-service postgres-service
kubectl --context=nest-crud -n nest-crud delete secret app-secret
```

`kubectl delete -f k8s/` also deletes the PVC declared in `postgres.yaml`. Deleting the namespace removes its PVC as well; the default Minikube storage reclaim policy normally deletes the underlying database data. Deleting the Minikube profile removes its local cluster storage. Treat these as data-deleting operations.

### Existing database backup and restore

Skip this section for a fresh installation. If the original ephemeral database is already running, stop application writes before taking a backup. Use its actual context and namespace if they differ from the examples.

Back up **before** applying the new PostgreSQL storage configuration:

```bash
kubectl --context=nest-crud -n nest-crud scale deployment/nest-api --replicas=0
kubectl --context=nest-crud -n nest-crud exec deployment/postgres -- \
  sh -ec 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
  > /tmp/nest-crud-before-pvc.sql
```

Confirm the dump command succeeded and the backup contains the expected schema and data. After applying `secret.yaml` and `postgres.yaml` and waiting for the replacement database to be ready, restore into the fresh database **before** starting the API:

```bash
kubectl --context=nest-crud -n nest-crud exec -i deployment/postgres -- \
  sh -ec 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
  < /tmp/nest-crud-before-pvc.sql
```

Then apply `api-deployment.yaml` to restore the declared replica count of one. If any backup or restore command fails, resolve that error before continuing. The PVC change alone does not migrate existing data.

## CRUD endpoints

| Method | URL | Action |
| --- | --- | --- |
| POST | `/api/todos` | Create a Todo |
| GET | `/api/todos` | List Todos, newest first |
| GET | `/api/todos/:id` | Get one Todo |
| PATCH | `/api/todos/:id` | Update the supplied fields |
| DELETE | `/api/todos/:id` | Delete a Todo; returns 204 |

These examples use local port 3000. Substitute port 3001 if that is your port-forward port.

### Create

```bash
curl -i http://localhost:3000/api/todos \
  -H 'Content-Type: application/json' \
  -d '{"title":"Learn NestJS","description":"Build a CRUD API"}'
```

Expected: HTTP `201` and the created Todo, including its `id`. Use that ID instead of `1` in the following examples.

### Read

```bash
curl http://localhost:3000/api/todos
curl http://localhost:3000/api/todos/1
```

### Update

```bash
curl -i -X PATCH http://localhost:3000/api/todos/1 \
  -H 'Content-Type: application/json' \
  -d '{"completed":true}'
```

Send `{"description":null}` to clear the description.

### Delete

```bash
curl -i -X DELETE http://localhost:3000/api/todos/1
```

Expected: HTTP `204 No Content` with an empty response body.

## Validation

- `title` is required for creation. After trimming, it must contain 1–200 characters.
- `description` is optional, accepts `null`, and has a maximum length of 2000 characters.
- `completed` is an optional boolean and defaults to `false`.
- PATCH requires at least one field.
- Unknown fields are rejected with HTTP 400.
- IDs must be positive PostgreSQL integers. Invalid IDs return 400; missing records return 404.

Example validation response:

```json
{
  "message": "Validation failed",
  "errors": [{ "path": "title", "message": "Too small: expected string to have >=1 characters" }]
}
```

## Build and verify

Test the image helper's success and failure handling without a cluster:

```bash
npm run test:k8s-images
```

These regression tests use command doubles and small real tar archives to check retries, missing/stale node images, silent import failures, explicit import failures, cleanup, and rebuilding. They do not verify a real Kubernetes rollout or network connection. The live checks in Kubernetes steps 5–9 are still required on your own running cluster.

Build the application and run the API integration test:

```bash
npm run build

# Run against an API backed by a test database.
npm run test:e2e
```

## Project structure

```text
src/
  main.ts
  app.module.ts
  config/env.ts
  common/pipes/zod-validation.pipe.ts
  prisma/                 # Database connection
  todos/                  # Controller, service, module, and Zod schemas
prisma/
  schema.prisma
  migrations/
k8s/
  secret.yaml             # Local database credentials
  postgres.yaml           # PVC, PostgreSQL Deployment, and Service
  api-deployment.yaml     # API Deployment, init containers, and Service
scripts/
  minikube-images.sh      # Host build/pull -> archive import -> node verification
test/
  todos.e2e.cjs
  minikube-images.test.cjs
Dockerfile
compose.yaml
```

Zod schemas provide both TypeScript DTO types and runtime validation. Controllers handle HTTP requests; services use Prisma to read and write database records.

References: [NestJS validation](https://docs.nestjs.com/validation), [Prisma 7 setup](https://www.prisma.io/docs/guides/upgrade-prisma-orm/v7), [Kubernetes init containers](https://kubernetes.io/docs/concepts/workloads/pods/init-containers/), [Kubernetes persistent storage](https://kubernetes.io/docs/tutorials/configuration/configure-persistent-volume-storage/), and [loading images into Minikube](https://minikube.sigs.k8s.io/docs/handbook/pushing/).
