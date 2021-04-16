/*
 * (c) Copyright Ascensio System SIA 2010-2019
 *
 * This program is a free software product. You can redistribute it and/or
 * modify it under the terms of the GNU Affero General Public License (AGPL)
 * version 3 as published by the Free Software Foundation. In accordance with
 * Section 7(a) of the GNU AGPL its Section 15 shall be amended to the effect
 * that Ascensio System SIA expressly excludes the warranty of non-infringement
 * of any third-party rights.
 *
 * This program is distributed WITHOUT ANY WARRANTY; without even the implied
 * warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR  PURPOSE. For
 * details, see the GNU AGPL at: http://www.gnu.org/licenses/agpl-3.0.html
 *
 * You can contact Ascensio System SIA at 20A-12 Ernesta Birznieka-Upisha
 * street, Riga, Latvia, EU, LV-1050.
 *
 * The  interactive user interfaces in modified source and object code versions
 * of the Program must display Appropriate Legal Notices, as required under
 * Section 5 of the GNU AGPL version 3.
 *
 * Pursuant to Section 7(b) of the License you must retain the original Product
 * logo when distributing the program. Pursuant to Section 7(e) we decline to
 * grant you any rights under trademark law for use of our trademarks.
 *
 * All the Product's GUI elements, including illustrations and icon sets, as
 * well as technical writing content are licensed under the terms of the
 * Creative Commons Attribution-ShareAlike 4.0 International. See the License
 * terms at http://creativecommons.org/licenses/by-sa/4.0/legalcode
 *
 */

'use strict';

const path = require('path');
const crypto = require('crypto');
const co = require('co');
const jwt = require('jsonwebtoken');
const config = require('config');
const logger = require('./../../Common/sources/logger');
const utils = require('./../../Common/sources/utils');
const sqlBase = require('./baseConnector');
const taskResult = require('./taskresult');
const canvasService = require('./canvasservice');

const cfgTokenOutboxAlgorithm = config.get('services.CoAuthoring.token.outbox.algorithm');
const cfgTokenOutboxExpires = config.get('services.CoAuthoring.token.outbox.expires');
const cfgSignatureSecretOutbox = config.get('services.CoAuthoring.secret.outbox');
const cfgTokenEnableBrowser = config.get('services.CoAuthoring.token.enable.browser');
const cfgWopiFileInfoBlockList = config.get('wopi.fileInfoBlockList');
const cfgWopiFavIconUrlWord = config.get('wopi.favIconUrlWord');
const cfgWopiFavIconUrlCell = config.get('wopi.favIconUrlCell');
const cfgWopiFavIconUrlSlide = config.get('wopi.favIconUrlSlide');
const cfgWopiPublicKey = config.get('wopi.publicKey');
const cfgWopiPrivateKey = config.get('wopi.privateKey');
const cfgWopiPublicKeyOld = config.get('wopi.publicKeyOld');
const cfgWopiPrivateKeyOld = config.get('wopi.privateKeyOld');

let fileInfoBlockList = cfgWopiFileInfoBlockList.keys();

function discovery(req, res) {
  return co(function*() {
    let output = '';
    try {
      logger.info('wopiDiscovery start');
      let baseUrl = utils.getBaseUrlByRequest(req);
      let names = ['Word','Excel','PowerPoint'];
      let favIconUrls = [cfgWopiFavIconUrlWord, cfgWopiFavIconUrlCell, cfgWopiFavIconUrlSlide];
      let exts = ['docx', 'xlsx', 'pptx'];
      let templateStart = `${baseUrl}/wopi?documentType=`;
      let templateEnd = `&amp;&lt;wopiSrc=WOPI_SOURCE&amp;&gt;`;
      let documentTypes = [`word`, `cell`, `slide`];
      output += `<?xml version="1.0" encoding="utf-8"?><wopi-discovery><net-zone name="external-https">`;
      for(let i = 0; i < names.length; ++i) {
        let name = names[i];
        let favIconUrl = favIconUrls[i];
        let ext = exts[i];
        let urlTemplate = `${templateStart}${documentTypes[i]}${templateEnd}`;
        output +=`<app name="${name}" favIconUrl="${favIconUrl}">
        	<action name="view" ext="${ext}" urlsrc="${urlTemplate}" />
        	<action name="edit" ext="${ext}" default="true" requires="locks,update" urlsrc="${urlTemplate}" />
        </app>`;
      }
      output += `</net-zone><proof-key oldvalue="${cfgWopiPublicKeyOld}" value="${cfgWopiPublicKey}"/></wopi-discovery>`;
    } catch (err) {
      logger.error('wopiDiscovery error\r\n%s', err.stack);
    } finally {
      res.setHeader('Content-Type', 'text/xml');
      res.send(output);
      logger.info('wopiDiscovery end');
    }
  });
}
function isWopiCallback(url) {
  return url && url.startsWith("{");
}
function parseWopiCallback(docId, userAuthStr, url) {
  let wopiParams = null;
  if (isWopiCallback(userAuthStr)) {
    let userAuth = JSON.parse(userAuthStr);
    let commonInfoStr = sqlBase.UserCallback.prototype.getCallbackByUserIndex(docId, url, 1);
    if (isWopiCallback(commonInfoStr)) {
      let commonInfo = JSON.parse(commonInfoStr);
      wopiParams = {commonInfo: commonInfo, userAuth: userAuth};
      logger.debug('parseWopiCallback wopiParams:%j', wopiParams);
    }
  }
  return wopiParams;
}
function getEditorHtml(req, res) {
  return co(function*() {
    try {
      logger.info('wopiEditor start');
      logger.debug(`wopiEditor req.url:${req.url}`);
      logger.debug(`wopiEditor req.query:${JSON.stringify(req.query)}`);
      logger.debug(`wopiEditor req.body:${JSON.stringify(req.body)}`);
      let wopiSrc = req.query['WOPISrc'];
      let documentType = req.query['documentType'];
      let access_token = req.body['access_token'];
      let access_token_ttl = req.body['access_token_ttl'];

      let uri = `${wopiSrc}?access_token=${access_token}`;

      //checkFileInfo
      let checkFileInfo = undefined;
      try {
        let getRes = yield utils.downloadUrlPromise(uri);
        checkFileInfo = JSON.parse(getRes.body);
        logger.debug(`wopiEditor checkFileInfo headers=%j body=%s`, getRes.response.headers, getRes.body);
      } catch (err) {
        if (err.response) {
          logger.error('wopiEditor error checkFileInfo statusCode=%s headers=%j', err.response.statusCode, err.response.headers);
        }
        logger.error('wopiEditor error checkFileInfo:%s', err.stack);
      }

      //docId
      let docId = undefined;
      if (checkFileInfo) {
        if (checkFileInfo.SHA256) {
          docId = checkFileInfo.SHA256;
        } else if (checkFileInfo.UniqueContentId) {
          docId = checkFileInfo.UniqueContentId;
        } else {
          let fileId = wopiSrc.substring(wopiSrc.lastIndexOf('/') + 1);
          docId = `${fileId}.${checkFileInfo.Version}`;
        }
      }
      logger.debug(`wopiEditor docId=%s`, docId);

      //Lock
      let lockId = undefined;
      if (checkFileInfo && checkFileInfo.SupportsLocks) {
        let isNewLock = true;
        let selectRes = yield taskResult.select(docId);
        if (selectRes.length > 0) {
          var row = selectRes[0];
          if (row.callback) {
            let callback = sqlBase.UserCallback.prototype.getCallbackByUserIndex(docId, row.callback, 1);
            if (callback) {
              lockId = JSON.parse(callback).lockId;
              isNewLock = false;
              logger.debug('wopiEditor lockId from DB lockId=%s', lockId);
            }
          }
        }

        if (isNewLock) {
          lockId = crypto.randomBytes(16).toString('base64');
        }
        try {
          let headers = {"X-WOPI-Override": "LOCK", "X-WOPI-Lock": lockId};
          fillStandardHeaders(headers, uri, access_token);
          logger.debug('wopi Lock request uri=%s headers=%j', uri, headers);
          let postRes = yield utils.postRequestPromise(uri, undefined, undefined, undefined, headers);
          logger.debug('wopiEditor Lock response headers=%j', postRes.response.headers);
        } catch (err) {
          lockId = undefined;
          if (err.response) {
            logger.error('wopiEditor error Lock statusCode=%s headers=%j', err.response.statusCode, err.response.headers);
          }
          logger.error('wopiEditor error Lock:%s', err.stack);
        }
        if (lockId && isNewLock) {
          let docProperties = JSON.stringify({lockId: lockId, fileInfo: checkFileInfo});
          yield canvasService.commandOpenStartPromise(docId, utils.getBaseUrlByRequest(req), true, docProperties);
        }
      } else {
        logger.info('wopi SupportsLocks = false');
      }

      if (checkFileInfo && (lockId || !checkFileInfo.SupportsLocks)) {
        for (let i in fileInfoBlockList) {
          if (fileInfoBlockList.hasOwnProperty(i)) {
            delete checkFileInfo[i];
          }
        }
        let userAuth = {wopiSrc: wopiSrc, access_token: access_token, access_token_ttl: access_token_ttl};
        let params = {key: docId, fileInfo: checkFileInfo, userAuth: userAuth, documentType: documentType};
        if (cfgTokenEnableBrowser) {
          let options = {algorithm: cfgTokenOutboxAlgorithm, expiresIn: cfgTokenOutboxExpires};
          let secret = utils.getSecretByElem(cfgSignatureSecretOutbox);
          params.token = jwt.sign(params, secret, options);
        }
        res.render("editor-wopi", params);
        logger.debug('wopiEditor render params=%j', params);
      } else {
        logger.error('wopiEditor can not open');
        res.sendStatus(400);
      }
    } catch (err) {
      logger.error('wopiEditor error\r\n%s', err.stack);
      res.sendStatus(400);
    } finally {
      logger.info('wopiEditor end');
    }
  });
}
function unlock(wopiParams) {
  return co(function* () {
    try {
      logger.info('wopi Unlock start');
      let fileInfo = wopiParams.commonInfo.fileInfo;
      let wopiSrc = wopiParams.userAuth.wopiSrc;
      let lockId = wopiParams.commonInfo.lockId;
      let access_token = wopiParams.userAuth.access_token;
      let uri = `${wopiSrc}?access_token=${access_token}`;

      if (fileInfo && fileInfo.SupportsLocks) {
        let headers = {"X-WOPI-Override": "UNLOCK", "X-WOPI-Lock": lockId};
        fillStandardHeaders(headers, uri, access_token);
        logger.debug('wopi Unlock request uri=%s headers=%j', uri, headers);
        let postRes = yield utils.postRequestPromise(uri, undefined, undefined, undefined, headers);
        logger.debug('wopi Unlock response headers=%j', postRes.response.headers);
      } else {
        logger.info('wopi SupportsLocks = false');
      }
    } catch (err) {
      if (err.response) {
        logger.error('wopi error Unlock statusCode=%s headers=%j', err.response.statusCode, err.response.headers);
      }
      logger.error('wopi error Unlock:%s', err.stack);
    } finally {
      logger.info('wopi Unlock end');
    }
  });
}
function generateProofBuffer(url, accessToken, timeStamp) {
  const accessTokenBytes = Buffer.from(accessToken, 'utf8');
  const urlBytes = Buffer.from(url.toUpperCase(), 'utf8');

  let offset = 0;
  let buffer = Buffer.alloc(4 + accessTokenBytes.length + 4 + urlBytes.length + 4 + 8);
  buffer.writeUInt32LE(accessTokenBytes.length, offset);
  offset += 4;
  buffer.copy(accessTokenBytes, offset, 0, accessTokenBytes.length);
  offset += accessTokenBytes.length;
  buffer.writeUInt32LE(urlBytes.length, offset);
  offset += 4;
  buffer.copy(urlBytes, offset, 0, urlBytes.length);
  offset += urlBytes.length;
  buffer.writeUInt32LE(8, offset);
  offset += 4;
  buffer.writeBigUInt64BE(timeStamp, offset);
  return buffer;
}
function generateProofSign(url, accessToken, timeStamp, privateKey) {
  let signer = crypto.createSign('RSA-SHA256');
  signer.update(generateProofBuffer(url, accessToken, timeStamp));
  return signer.sign({key:privateKey}, "base64");
}
function generateProof(url, accessToken, timeStamp) {
  let privateKey = `-----BEGIN PRIVATE KEY-----\n${cfgWopiPrivateKey}\n-----END PRIVATE KEY-----`;
  return generateProofSign(url, accessToken, timeStamp, privateKey);
}
function generateProofOld(url, accessToken, timeStamp) {
  let privateKey = `-----BEGIN PRIVATE KEY-----\n${cfgWopiPrivateKeyOld}\n-----END PRIVATE KEY-----`;
  return generateProofSign(url, accessToken, timeStamp, privateKey);
}
function fillStandardHeaders(headers, url, access_token) {
  let timeStamp = utils.getDateTimeTicks(new Date());
  headers['X-WOPI-Proof'] = generateProof(url, access_token, timeStamp);
  headers['X-WOPI-ProofOld'] = generateProof(url, access_token, timeStamp);
  headers['X-WOPI-TimeStamp'] = timeStamp;
}

exports.discovery = discovery;
exports.parseWopiCallback = parseWopiCallback;
exports.getEditorHtml = getEditorHtml;
exports.unlock = unlock;
exports.generateProof = generateProof;
exports.generateProofOld = generateProofOld;
exports.fillStandardHeaders = fillStandardHeaders;

