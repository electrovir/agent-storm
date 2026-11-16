import {type MaybePromise} from '@augment-vir/common';
import {
    type ApprovalDecision,
    type ApprovalRequest,
    type ProviderModel,
    type ReasoningEffort,
    type RuntimeMode,
    type ThreadItem,
    type ThreadStatus,
} from '../../build-v2-api.js';

/** An item as a provider describes it, before it belongs to a thread and turn. */
export type ProviderItem = Readonly<
    Pick<ThreadItem, 'kind' | 'status' | 'title' | 'text'> & {
        /** The provider's own id for the item, which later updates to the same item reuse. */
        providerItemId: string;
    }
>;

/** Where a provider session reports what its agent does. Bound to one thread. */
export type ProviderSink = Readonly<{
    putItem(item: ProviderItem): MaybePromise<void>;
    appendDelta(params: Readonly<{providerItemId: string; delta: string}>): void;
    setStatus(status: ThreadStatus): MaybePromise<void>;
    /** Records the id the provider resumes the conversation by. */
    setProviderSessionId(providerSessionId: string): MaybePromise<void>;
    /**
     * Shows the user a request and resolves to their answer. Resolves to a decline when `signal`
     * aborts or the session stops first.
     */
    requestApproval(
        request: Readonly<Pick<ApprovalRequest, 'kind' | 'title' | 'detail' | 'reason'>>,
        signal?: AbortSignal | undefined,
    ): Promise<ApprovalDecision>;
    addNotice(text: string): MaybePromise<void>;
    /** The provider's process ended, so the next message must start a new session. */
    endSession(): void;
}>;

/** A running provider process for one thread. */
export type ProviderSession = Readonly<{
    send(text: string): MaybePromise<void>;
    interrupt(): Promise<void>;
    setRuntimeMode(runtimeMode: RuntimeMode): MaybePromise<void>;
    stop(): void;
}>;

export type ProviderAdapter = Readonly<{
    /** Starts the provider's CLI in `cwd` only long enough to ask it for its models. */
    listModels(
        params: Readonly<{
            cwd: string;
        }>,
    ): Promise<ProviderModel[]>;
    start(
        params: Readonly<{
            cwd: string;
            /** Empty for the provider's default model. */
            model: string;
            /** Unset for the model's default effort. */
            effort: ReasoningEffort | undefined;
            runtimeMode: RuntimeMode;
            /** Resumes this conversation when set. */
            providerSessionId: string | null;
            sink: ProviderSink;
        }>,
    ): Promise<ProviderSession>;
}>;
