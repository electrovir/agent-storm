/*
 * Zoho Mail custom function (Node.js runtime).
 *
 * Re-sends an incoming message AS this mailbox's own verified address instead of
 * forwarding it. A plain forward keeps the original `From:` header, which is the
 * identity Gmail keys its per-sender quota on (that is why the bounce blames
 * noreply@extendedcare.com even though the envelope is already snf-ltc.com).
 * Sending a fresh message as our own address gives an aligned, first-party
 * sender that Gmail accepts.
 *
 * Setup:
 *   Settings > Filters > (add/edit filter) > Actions > Custom function.
 *   Pass the built-in argument "mail_messageId".
 *   The filter's own conditions must ALSO match every accepted sender below
 *   (e.g. "Any of these conditions": From contains extendedcare OR From
 *   contains jalen@flax.ai) — the function only runs on mail the filter
 *   already matched; the list below is a second gate, not a matcher.
 *   The DRE connection "mailconnection" needs these ZohoMail scopes:
 *     ZohoMail.messages.READ    (read the message, download attachments)
 *     ZohoMail.messages.CREATE  (upload attachments, send)
 *
 * I could not run this in your account. Confirm these before relying on it:
 *   1. apiBase region: mail.zoho.com vs mail.zoho.eu / .in / .com.au etc.
 *   2. getMessage return keys: the first run logs the full messageDetails via
 *      context.log.INFO. The body/subject come back UPPERCASE (CONTENT/SUBJECT)
 *      in your template; verify folderId, the sender key, and the attachments
 *      array key names and adjust the reads below, then delete that log line.
 *   3. makeRequestSync shape: modeled as a stream (.on data/error/end +
 *      .statusCode). If your runtime returns it differently, only the `request`
 *      helper needs to change.
 *   4. destinationAddress for this filter (see note at the bottom).
 */

const apiBase = 'https://mail.zoho.com';

/*
 * Where the rewritten copy is delivered. Set this per filter. If you route many
 * facility addresses through one mailbox via plus-encoding, derive it from the
 * original recipient instead (see the note at the bottom of this file).
 */
const destinationAddress = 'incoming-referrals-2+wellbridge-f-careport@flax.ai';

/*
 * Only mail from these senders is re-sent; anything else is logged and skipped.
 * A plain address must match exactly; a bare domain accepts any address at that
 * domain or a subdomain of it.
 */
const acceptedSenders = ['jalen@flax.ai', 'extendedcare.com'];

function extractAddress(rawFrom) {
    const raw = String(rawFrom || '');
    const angleMatch = raw.match(/<([^>]+)>/);
    return (angleMatch ? angleMatch[1] : raw).trim().toLowerCase();
}

function isAcceptedSender(address) {
    const domain = address.split('@')[1] || '';
    return acceptedSenders.some(function (entry) {
        if (entry.includes('@')) {
            return address === entry;
        }
        return domain === entry || domain.endsWith('.' + entry);
    });
}

module.exports = async function (context, basicIO) {
    const connector = context.getConnection('mailconnection');
    const zohomail = context.getIntegrationTask().getService('ZohoMail', connector);
    const messageId = basicIO.getParameter('mail_messageId').toString();

    /*
     * Authenticated request through the connection (it injects the OAuth token).
     * Resolves both raw bytes (for attachment downloads) and text (for JSON).
     */
    function request(options, body) {
        return new Promise(function (resolve, reject) {
            const chunks = [];
            const response = connector.makeRequestSync(options, body);
            response.on('data', function (chunk) {
                chunks.push(Buffer.from(chunk));
            });
            response.on('error', function (error) {
                reject(error);
            });
            response.on('end', function () {
                const buffer = Buffer.concat(chunks);
                resolve({
                    statusCode: response.statusCode,
                    buffer: buffer,
                    text: buffer.toString(),
                });
            });
        });
    }

    /* read the source message (getMessage resolves folder + content from the id) */
    const rawMessage = await zohomail.getMessage(messageId);
    /* this runtime's getMessage returns an object already; only parse a JSON string */
    const messageDetails = typeof rawMessage === 'string' ? JSON.parse(rawMessage) : rawMessage;
    /* TEMP: confirm the real key casing (folderId/SUBJECT/CONTENT/from/attachments), then delete */
    context.log.INFO('getMessage typeof=' + typeof rawMessage);
    context.log.INFO(JSON.stringify(messageDetails));

    /* key casing unverified — first run's log line above tells you which one is real */
    const senderAddress = extractAddress(
        messageDetails.fromAddress ||
            messageDetails.FROMADDRESS ||
            messageDetails.sender ||
            messageDetails.FROM,
    );
    if (!isAcceptedSender(senderAddress)) {
        context.log.INFO('skipped: sender not accepted: ' + senderAddress);
        return;
    }

    /* account id + a verified from-address for this mailbox */
    const accountsResponse = await request({
        url: apiBase + '/api/accounts',
        method: 'GET',
    });
    const account = JSON.parse(accountsResponse.text).data[0];
    const accountId = account.accountId;
    const sendFromAddress = account.sendMailDetails[0].fromAddress || account.primaryEmailAddress;

    const folderId = messageDetails.folderId;
    const subject = messageDetails.SUBJECT;
    const content = messageDetails.CONTENT;
    const attachments = messageDetails.attachments || [];

    /*
     * Re-upload each original attachment: download raw bytes, then upload one at a
     * time via the raw single-file method (fileName in the query, bytes in the
     * body) so there is no multipart body to hand-build. Sequential to stay well
     * under Zoho's rate limits.
     */
    const attachmentRefs = [];
    for (const attachment of attachments) {
        const download = await request({
            url:
                apiBase +
                '/api/accounts/' +
                accountId +
                '/folders/' +
                folderId +
                '/messages/' +
                messageId +
                '/attachments/' +
                attachment.attachmentId,
            method: 'GET',
            headers: {Accept: 'application/octet-stream'},
        });

        const upload = await request(
            {
                url:
                    apiBase +
                    '/api/accounts/' +
                    accountId +
                    '/messages/attachments?fileName=' +
                    encodeURIComponent(attachment.attachmentName),
                method: 'POST',
                headers: {'Content-Type': 'application/octet-stream'},
            },
            download.buffer,
        );

        const uploaded = JSON.parse(upload.text).data[0];
        attachmentRefs.push({
            storeName: uploaded.storeName,
            attachmentName: uploaded.attachmentName,
            attachmentPath: uploaded.attachmentPath,
        });
    }

    /* send the rewritten copy as our own address */
    const sendBody = {
        fromAddress: sendFromAddress,
        toAddress: destinationAddress,
        subject: subject,
        content: content,
        mailFormat: 'html',
    };
    if (attachmentRefs.length > 0) {
        sendBody.attachments = attachmentRefs;
    }

    const sendResponse = await request(
        {
            url: apiBase + '/api/accounts/' + accountId + '/messages',
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
        },
        JSON.stringify(sendBody),
    );

    context.log.INFO('send status ' + sendResponse.statusCode + ': ' + sendResponse.text);
};

/*
 * Multi-facility / plus-encoded destination:
 * If one mailbox receives many facility addresses (e.g. the recipient looks like
 * jjensen+uml_=incoming-referrals-2+wellbridge-f-careport=flax.ai@snf-ltc.com),
 * the real flax target is encoded in the plus tag. Replace the fixed
 * destinationAddress with a decode of messageDetails.toAddress: take the local
 * part up to the first "+", drop your routing prefix ("uml_="), then turn the
 * final "=" back into "@". Verify against a real recipient before trusting it,
 * since that encoding is specific to your forward.
 */
