# Test API Project

A minimal REST API with JWT authentication and SQLite storage.

## Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | /login | No | Authenticate with email/password, returns JWT |
| GET | /users | Yes | List all users |
| GET | /users/:id | Yes | Get user by ID |
| POST | /users | Yes | Create a new user |
| DELETE | /users/:id | Yes | Delete a user |

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 3000 | Server listen port |
| `DB_PATH` | ./data.db | SQLite database file path |
| `JWT_SECRET` | (required) | Secret key for JWT signing |
| `LOG_LEVEL` | info | Logging level: debug, info, warn, error |

## Architecture

- `src/config/` — Configuration loading from environment variables
- `src/auth/` — JWT middleware and login handler
- `src/api/` — REST route handlers and router setup
- `src/database/` — SQLite schema and connection management
- `src/utils/` — Logging utilities
