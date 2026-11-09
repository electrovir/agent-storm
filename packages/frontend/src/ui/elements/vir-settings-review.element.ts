import {type Settings} from '@agent-storm/common';
import {defineAppElement, type ReviewedRepo, toRepoKey} from '@agent-storm/core/frontend';
import {css, defineElementEvent, html, listen} from 'element-vir';
import {ViraInput} from 'vira';
import {type ValueUpdate} from '../../util/batched-writer.js';
import {settingsCardCss, VirSettingsRow} from './vir-settings-row.element.js';

/** The Settings modal's Review section: the init command run in each new review checkout. */
export const VirSettingsReview = defineAppElement<{
    settings: Readonly<Settings>;
    /** Listed first, even before it has a command of its own. */
    reviewRepo: Readonly<ReviewedRepo> | undefined;
}>()({
    tagName: 'vir-settings-review',
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
    render({inputs, dispatch, events}) {
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

        const targetRepo = inputs.reviewRepo;
        const repos = [
            ...(targetRepo &&
            !review.repos.some((entry) => toRepoKey(entry) === toRepoKey(targetRepo))
                ? [
                      {
                          ...targetRepo,
                          initCmd: '',
                      },
                  ]
                : []),
            ...review.repos,
        ];
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
                ${repos.length
                    ? repos.map((repo) => {
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
                      })
                    : html`
                          <div class="card-hint">
                              A repo gets its own command from its settings menu in the Review
                              sidebar.
                          </div>
                      `}
            </div>
        `;
    },
});
