import {type Settings} from '@agent-storm/common';
import {
    defineAppElement,
    settingsCardCss,
    type ValueUpdate,
    VirSettingsRow,
} from '@agent-storm/core/frontend';
import {css, defineElementEvent, html, listen} from 'element-vir';
import {ViraDropdown, ViraInput} from 'vira';
import {type ReviewedRepo, toRepoKey} from '../../util/pr-reviews.js';

/** The Settings modal's Review section: the init command run in each new review checkout. */
export const VirSettingsReview = defineAppElement<{
    settings: Readonly<Settings>;
    /** Listed first, even before it has a command of its own. */
    reviewRepo: Readonly<ReviewedRepo> | undefined;
    /** The repos in the review queues, which the user can pick to give a command of their own. */
    queueRepos: ReadonlyArray<Readonly<ReviewedRepo>>;
}>()({
    tagName: 'vir-settings-review',
    state() {
        return {
            /** Picked this session, and listed even before they have a command of their own. */
            pickedRepos: [] as ReadonlyArray<Readonly<ReviewedRepo>>,
        };
    },
    events: {
        settingsChange: defineElementEvent<ValueUpdate<Settings>>(),
    },
    styles: css`
        ${settingsCardCss}

        :host {
            display: flex;
            flex-direction: column;
            gap: 16px;
        }
    `,
    render({inputs, state, updateState, dispatch, events}) {
        function changeReview(update: ValueUpdate<Settings['review']>) {
            dispatch(
                new events.settingsChange({
                    detail(current) {
                        return {
                            ...current,
                            review: update(current.review),
                        };
                    },
                }),
            );
        }

        const review = inputs.settings.review;

        function setRepoCommand(repo: Readonly<ReviewedRepo>, initCmd: string | undefined) {
            changeReview((current) => {
                const others = current.repos.filter(
                    (entry) => toRepoKey(entry) !== toRepoKey(repo),
                );
                return {
                    ...current,
                    repos:
                        initCmd == undefined
                            ? others
                            : [
                                  ...others,
                                  {
                                      owner: repo.owner,
                                      repoName: repo.repoName,
                                      initCmd,
                                  },
                              ],
                };
            });
        }

        const pendingRepos = [
            ...(inputs.reviewRepo
                ? [
                      inputs.reviewRepo,
                  ]
                : []),
            ...state.pickedRepos,
        ];
        const repos = [
            ...pendingRepos
                .filter((repo, index) => {
                    return (
                        !review.repos.some((entry) => toRepoKey(entry) === toRepoKey(repo)) &&
                        pendingRepos.findIndex((other) => toRepoKey(other) === toRepoKey(repo)) ===
                            index
                    );
                })
                .map((repo) => {
                    return {
                        ...repo,
                        initCmd: '',
                    };
                }),
            ...review.repos,
        ];
        const unlistedRepos = inputs.queueRepos.filter((repo) => {
            return !repos.some((entry) => toRepoKey(entry) === toRepoKey(repo));
        });
        const placeholder = review.initCmd ? `Default: ${review.initCmd}` : 'None';

        return html`
            <div class="card">
                <${VirSettingsRow.assign({
                    rowTitle: 'Default init command',
                    description:
                        'Runs in each new review checkout of a repo without a command of its own.',
                    isModified: !!review.initCmd,
                })}
                    ${listen(VirSettingsRow.events.reset, () => {
                        changeReview((current) => {
                            return {
                                ...current,
                                initCmd: '',
                            };
                        });
                    })}
                >
                    <${ViraInput.assign({
                        value: review.initCmd,
                        placeholder: 'None',
                        showClearButton: true,
                        disableBrowserHelps: true,
                    })}
                        ${listen(ViraInput.events.valueChange, (event) => {
                            changeReview((current) => {
                                return {
                                    ...current,
                                    initCmd: event.detail,
                                };
                            });
                        })}
                    ></${ViraInput}>
                </${VirSettingsRow}>
            </div>
            <span class="card-title">Repos</span>
            <div class="card">
                <${VirSettingsRow.assign({
                    rowTitle: 'Add a repo',
                    description: 'Gives a repo from your review queues a command of its own.',
                })}>
                    <${ViraDropdown.assign({
                        options: unlistedRepos.map((repo) => {
                            return {
                                value: toRepoKey(repo),
                                label: toRepoKey(repo),
                            };
                        }),
                        selected: [],
                        placeholder: unlistedRepos.length
                            ? 'Pick a repo...'
                            : 'No other repos in your review queues',
                        isSearchable: true,
                        isDisabled: !unlistedRepos.length,
                    })}
                        ${listen(ViraDropdown.events.selectedValuesChange, (event) => {
                            const picked = unlistedRepos.find((repo) => {
                                return toRepoKey(repo) === event.detail[0];
                            });
                            if (picked) {
                                updateState({
                                    pickedRepos: [
                                        ...state.pickedRepos,
                                        picked,
                                    ],
                                });
                            }
                        })}
                    ></${ViraDropdown}>
                </${VirSettingsRow}>
                ${repos.map((repo) => {
                    return html`
                        <${VirSettingsRow.assign({
                            rowTitle: toRepoKey(repo),
                            isModified: review.repos.some(
                                (entry) => toRepoKey(entry) === toRepoKey(repo),
                            ),
                        })}
                            ${listen(VirSettingsRow.events.reset, () => {
                                setRepoCommand(repo, undefined);
                            })}
                        >
                            <${ViraInput.assign({
                                value: repo.initCmd,
                                placeholder,
                                showClearButton: true,
                                disableBrowserHelps: true,
                            })}
                                ${listen(ViraInput.events.valueChange, (event) => {
                                    setRepoCommand(repo, event.detail);
                                })}
                            ></${ViraInput}>
                        </${VirSettingsRow}>
                    `;
                })}
            </div>
        `;
    },
});
