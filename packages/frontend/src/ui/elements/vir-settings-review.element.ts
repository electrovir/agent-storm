import {type ReviewConfig} from '@agent-storm/common';
import {css, defineElementEvent, html, listen} from 'element-vir';
import {ViraInput} from 'vira';
import {type ValueUpdate} from '../../util/batched-writer.js';
import {defineAppElement} from '../define-app-element.js';
import {type ReviewedRepo, toRepoKey} from './review-sidebar-display.js';
import {settingsCardCss, VirSettingsRow} from './vir-settings-row.element.js';

/** The Settings modal's Review section: the init command run in each new review checkout. */
export const VirSettingsReview = defineAppElement<{
    reviewConfig: Readonly<ReviewConfig>;
    /** Listed first, even before it has a command of its own. */
    reviewRepo: Readonly<ReviewedRepo> | undefined;
}>()({
    tagName: 'vir-settings-review',
    events: {
        reviewConfigChange: defineElementEvent<ValueUpdate<ReviewConfig>>(),
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
        function changeReviewConfig(update: ValueUpdate<ReviewConfig>) {
            dispatch(
                new events.reviewConfigChange({
                    detail: update,
                }),
            );
        }

        function setRepoCommand(repo: Readonly<ReviewedRepo>, initCmd: string | undefined) {
            changeReviewConfig((current) => {
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
            !inputs.reviewConfig.repos.some((entry) => toRepoKey(entry) === toRepoKey(targetRepo))
                ? [
                      {
                          ...targetRepo,
                          initCmd: '',
                      },
                  ]
                : []),
            ...inputs.reviewConfig.repos,
        ];
        const placeholder = inputs.reviewConfig.defaultInitCmd
            ? `Default: ${inputs.reviewConfig.defaultInitCmd}`
            : 'None';

        return html`
            <div class="card">
                <${VirSettingsRow.assign({
                    rowTitle: 'Default init command',
                    description:
                        'Runs in each new review checkout of a repo without a command of its own.',
                    isModified: !!inputs.reviewConfig.defaultInitCmd,
                })}
                    ${listen(VirSettingsRow.events.reset, () => {
                        changeReviewConfig((current) => {
                            return {
                                ...current,
                                defaultInitCmd: '',
                            };
                        });
                    })}
                >
                    <${ViraInput.assign({
                        value: inputs.reviewConfig.defaultInitCmd,
                        placeholder: 'None',
                        showClearButton: true,
                        disableBrowserHelps: true,
                    })}
                        ${listen(ViraInput.events.valueChange, (event) => {
                            changeReviewConfig((current) => {
                                return {
                                    ...current,
                                    defaultInitCmd: event.detail,
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
                                  isModified: inputs.reviewConfig.repos.some(
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
