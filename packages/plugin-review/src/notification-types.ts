import {defineNotificationType, type NotificationType} from '@agent-storm/common';
import {reviewActivityId} from './review-api.js';

/** What the Review plugin can notify the user of. */
export enum ReviewNotificationName {
    NewReviewRequest = 'newReviewRequest',
}

export const reviewNotificationTypes: Readonly<Record<ReviewNotificationName, NotificationType>> = {
    [ReviewNotificationName.NewReviewRequest]: defineNotificationType({
        name: ReviewNotificationName.NewReviewRequest,
        pluginId: reviewActivityId,
        label: 'New PR to review',
        description: "A PR joins the Review tab's Reviewer list.",
    }),
};
