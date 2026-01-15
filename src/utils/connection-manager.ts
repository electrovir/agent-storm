import type {SshConnection} from '../ssh/ssh-connection.js';

class ConnectionManager {
    private connections: Map<string, SshConnection> = new Map();
    private selectedConnectionId: string | null = null;

    public addConnection(connection: SshConnection): void {
        this.connections.set(connection.id, connection);
        if (!this.selectedConnectionId) {
            this.selectedConnectionId = connection.id;
        }
    }

    public removeConnection(id: string): void {
        const connection = this.connections.get(id);
        if (connection) {
            if (connection.shell) {
                connection.shell.end();
            }
            connection.client.end();
            this.connections.delete(id);
        }

        if (this.selectedConnectionId === id) {
            const remaining = Array.from(this.connections.keys());
            this.selectedConnectionId = remaining[0] ?? null;
        }
    }

    public getConnection(id: string): SshConnection | undefined {
        return this.connections.get(id);
    }

    public getSelectedConnection(): SshConnection | undefined {
        if (!this.selectedConnectionId) {
            return undefined;
        }
        return this.connections.get(this.selectedConnectionId);
    }

    public selectConnection(id: string): void {
        if (this.connections.has(id)) {
            this.selectedConnectionId = id;
        }
    }

    public getAllConnections(): SshConnection[] {
        return Array.from(this.connections.values());
    }

    public getSelectedConnectionId(): string | null {
        return this.selectedConnectionId;
    }

    public isRepoInUse(repoPath: string): SshConnection | undefined {
        for (const conn of this.connections.values()) {
            if (conn.repoPath === repoPath && !conn.worktreePath) {
                return conn;
            }
        }
        return undefined;
    }

    public selectNext(): void {
        const ids = Array.from(this.connections.keys());
        if (ids.length === 0) {
            return;
        }

        const currentIndex = this.selectedConnectionId
            ? ids.indexOf(this.selectedConnectionId)
            : -1;
        const nextIndex = (currentIndex + 1) % ids.length;
        const nextId = ids[nextIndex];
        if (nextId) {
            this.selectedConnectionId = nextId;
        }
    }

    public selectPrevious(): void {
        const ids = Array.from(this.connections.keys());
        if (ids.length === 0) {
            return;
        }

        const currentIndex = this.selectedConnectionId ? ids.indexOf(this.selectedConnectionId) : 0;
        const prevIndex = (currentIndex - 1 + ids.length) % ids.length;
        const prevId = ids[prevIndex];
        if (prevId) {
            this.selectedConnectionId = prevId;
        }
    }
}

export const connectionManager = new ConnectionManager();
