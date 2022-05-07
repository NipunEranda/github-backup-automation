const config = require('./config');
const child_process = require('child_process');
const { Octokit } = require("@octokit/rest");
const aws = require('aws-sdk');
const fs = require("fs");
const stream = require("stream");
const request = require("request");
const Promise = require("bluebird");
const mime = require('mime-types');
const { spawn } = require('child_process');

let options = { stdio: 'ignore', shell: true };
let mode = null;
let codecommit = null;
let s3 = null;
let repositories = null;
let codeCommitRepoExists = null;

//Initialize github api
const octokit = new Octokit({
    auth: config.GITHUB_ACCESS_TOKEN,
});

//Get organizations list from github
async function getOrganizations() {
    try {
        const organizations = await octokit.rest.orgs.listForAuthenticatedUser();
        if (organizations.data.length > 0) {
            return organizations.data;
        } else {
            return {
                message: 'You are not in an organization',
                error: true
            };
        }
    } catch (e) {
        console.log(e);
        writeLog(e);
        return null;
    }
}

//Get repositories for each organization from github
async function getRepoList() {
    let repos = [];
    try {
        const organizations = await getOrganizations();
        if (!organizations.error) {
            await Promise.all(organizations.map(async (org) => {
                await octokit.paginate(
                    octokit.repos.listForOrg,
                    {
                        org: org.login,
                        type: 'all',
                        per_page: 100,
                    },
                    (response) => {
                        response.data.forEach(repo => {
                            repos.push(repo);
                        });
                    }
                );
            }));
            if (repos.length > 0) {
                return repos;
            } else {
                return {
                    message: 'There aren\'t any repositories.',
                    error: true
                };
            }
        } else {
            return {
                message: organizations.message,
                error: organizations.error
            };
        }
    } catch (e) {
        console.log(e);
        writeLog(e);
        return null;
    }
}

//Github to Codecommit backup process
async function localToCC() {
    try {
        return new Promise(async (resolve, reject) => {
            console.log('\n####################### Started Github Backup Process #######################\n');
            writeLog('\n####################### Started Github Backup Process #######################\n');
            repositories = await getRepoList();
            repositories = repositories.sort((a, b) => b.size - a.size);
            repositories.forEach(async (repository, index) => {
                let username = repository.owner.login;
                let repo = repository.name;
                //Check if the repository exists on codecommit.Create a repository if it doesn't exists.
                if (mode === 'cc' || mode === undefined) {
                    codecommit.getRepository({ repositoryName: `${username}_${repo}` }, function (err, data) {
                        if (err) {
                            if (err.code === 'RepositoryDoesNotExistException') {
                                if (repository.description) {
                                    if (repository.description != "") {
                                        codecommit.createRepository({ repositoryName: `${username}_${repo}`, repositoryDescription: `${(repository.description) ? repository.description : ''}` }, function (err, data) {
                                            if (err) {
                                                console.log(err, err.stack);
                                                writeLog(`${repository.full_name} repository creattion failed in codecommit.`);
                                                writeLog(err);
                                            }
                                        });
                                    } else {
                                        codecommit.createRepository({ repositoryName: `${username}_${repo}`}, function (err, data) {
                                            if (err) {
                                                console.log(err, err.stack);
                                                writeLog(`${repository.full_name} repository creattion failed in codecommit.`);
                                                writeLog(err);
                                            }
                                        });
                                    }
                                } else {
                                    codecommit.createRepository({ repositoryName: `${username}_${repo}`}, function (err, data) {
                                        if (err) {
                                            console.log(err, err.stack);
                                            writeLog(`${repository.full_name} repository creattion failed in codecommit.`);
                                            writeLog(err);
                                        }
                                    });
                                }
                                writeLog(`${repository.full_name} repository created in codecommit.`);
                            }
                        }
                    });
                }

                //Get repository branches list from the github
                const branches = (await octokit.rest.repos.listBranches({ owner: repository.owner.login, repo: repository.name })).data;

                branches.forEach(async branch => {
                    await syncBranchesToLocal(username, repo, branch).then(() => {
                        if (mode === 'cc' || mode === undefined) {
                            child_process.execSync(`cd ${config.LOCAL_BACKUP_PATH}/repos/${username}/${repo} && git push ssh://git-codecommit.us-east-1.amazonaws.com/v1/repos/${username}_${repo} ${branch.name}`, options);
                            writeLog(`${branch.name} branch synced to codecommit in ${repository.full_name} repository.`);
                        }
                    });
                });

                //If the github repository default branch is not the default branch in codecommit. set it to the original default branch.
                if (mode === 'cc' || mode === undefined) {
                    codecommit.getRepository({ repositoryName: `${username}_${repo}` }, function (err, data) {
                        if (data.repositoryMetadata.defaultBranch !== repository.default_branch) {
                            try {
                                codecommit.updateDefaultBranch({ defaultBranchName: repository.default_branch, repositoryName: `${username}_${repo}` }, function (err, data) {
                                    if (err === null) {
                                        console.log(`Default branch set to ${repository.default_branch} in ${username}_${repo}`);
                                        writeLog(`Default branch set to ${repository.default_branch} in ${username}_${repo}`);
                                    }
                                });
                            } catch (e) {
                                console.log(e);
                                writeLog(e);
                            }
                        }
                    });

                    //Remove deleted branches
                    codecommit.listBranches({ repositoryName: `${username}_${repo}` }, function (err, data) {
                        data.branches.forEach(cb => {
                            if (!(branches.filter(b => b.name === cb).length > 0)) {
                                codecommit.deleteBranch({ branchName: cb, repositoryName: `${username}_${repo}` }, function (err, data) {
                                    if (err === null) {
                                        console.log(`${cb} branch removed from codecommit.`);
                                        writeLog(`${cb} branch removed from codecommit.`);
                                    } else {
                                        console.log(err);
                                        writeLog(err);
                                    }
                                });
                            }
                        });
                    });
                    console.log(`[✓] ${repo} Repository synced to codecommit.\n`);
                    writeLog(`[✓] ${repo} Repository synced to codecommit.\n`);
                }
                if (mode === 'none')
                    console.log(`[✓] ${repo} Repository locally synced.\n`);
                writeLog(`[✓] ${repo} Repository locally synced.\n`);
            });
            setTimeout(() => {
                resolve();
                ;
            }, 5000
            );
        });
    } catch (e) {
        console.log(e);
        writeLog(e);
        return e;
    }
}

async function localToS3() {
    try {
        return new Promise(async (resolve, reject) => {
            await localToCC();
            if (mode === 's3' || mode === undefined) {
                repositories.forEach(async repo => {
                    if (repoUpdated(repo) || !(await objectExistsInS3(repo))) {
                        if (fs.existsSync(`${config.LOCAL_BACKUP_PATH}/repos/${repo.owner.login}/${repo.name}`)) {
                            createTheZipFile(repo).then(async () => {
                                const stream = fs.createReadStream(`${config.LOCAL_BACKUP_PATH}/repos/${repo.full_name}.zip`);
                                const contentType = mime.lookup(`${config.LOCAL_BACKUP_PATH}/repos/${repo.full_name}.zip`);

                                const params = {
                                    Bucket: config.AWS_S3_BUCKET_NAME,
                                    Key: repo.full_name + ".zip",
                                    Body: stream,
                                    ContentType: contentType
                                };

                                try {
                                    await s3.upload(params, { partSize: 10 * 1024 * 1024, queueSize: 5 }).promise();
                                    child_process.execSync(`rm ${config.LOCAL_BACKUP_PATH}/repos/${repo.full_name}.zip`, options);
                                    console.log(`[✓] ${config.LOCAL_BACKUP_PATH}/repos/${repo.full_name}.zip uploaded to s3`);
                                    writeLog(`[✓] ${config.LOCAL_BACKUP_PATH}/repos/${repo.full_name}.zip uploaded to s3`);
                                } catch (error) {
                                    console.log('upload ERROR', `${config.LOCAL_BACKUP_PATH}/repos/${repo.full_name}.zip`, error);
                                    writeLog(`upload ERROR: ${config.LOCAL_BACKUP_PATH}/repos/${repo.full_name}.zip`);
                                }
                            });
                        }
                    } else {
                        console.log(`${repo.name} repository s3 upload skipped. Latest version already exists.`);
                        writeLog(`${repo.name} repository s3 upload skipped. Latest version already exists.`);
                    }
                });
            }
            setTimeout(() => {
                resolve();
                ;
            }, 5000
            );
        });
    } catch (e) {
        console.log(e);
        writeLog(e);
    }
}

//Create a zip file of the repository
async function createTheZipFile(repo) {
    console.log(`Creating ${repo.full_name}.zip : size - ${repo.size / 1000}`);
    writeLog(`Creating ${repo.full_name}.zip : size - ${repo.size / 1000}`);
    child_process.execSync(`cd ${config.LOCAL_BACKUP_PATH}/repos/ && zip -r ${config.LOCAL_BACKUP_PATH}/repos/${repo.full_name}.zip ${repo.owner.login}/${repo.name}`, options);
}

async function syncBranchesToLocal(username, repo, branch) {
    if (!fs.existsSync(`${config.LOCAL_BACKUP_PATH}/repos/${username}/${repo}`)) {
        console.log(`clonning ${repo} repository`);
        writeLog(`clonning ${repo} repository`);
        child_process.execSync(`git clone https://${username}:${config.GITHUB_ACCESS_TOKEN}@github.com/${username}/${repo}.git ${config.LOCAL_BACKUP_PATH}/repos/${username}/${repo}`, options);
        child_process.execSync(`cd ${config.LOCAL_BACKUP_PATH}/repos/${username}/${repo} && git fetch && git checkout ${branch.name} && git pull origin ${branch.name}`, options);
        console.log(`${repo} repository cloned`);
        writeLog(`${repo} repository cloned`);
    } else {
        //child_process.execSync(`cd ${config.LOCAL_BACKUP_PATH}/repos/${repository.owner.login}/${repository.name} && git fetch && git checkout ${branch.name} && git pull origin ${branch.name}`, options);
        spawn(`cd ${config.LOCAL_BACKUP_PATH}/repos/${username}/${repo} && git fetch && git checkout ${branch.name} && git pull origin ${branch.name}`, [], options);
        console.log(`${repo}:${branch.name} refreshed`);
        writeLog(`${repo}:${branch.name} refreshed`);
    }
}

async function backupProcess() {
    await localToS3();
}

module.exports.init = async (m) => {
    mode = m;

    //Initialize aws, codecommit and s3
    if (mode !== 'none') {
        aws.config.credentials = new aws.Credentials(config.AWS_CC_ACCESS_KEY, config.AWS_CC_ACCESS_SECRET);
        if (mode === 'cc' || mode === undefined)
            codecommit = new aws.CodeCommit({ apiVersion: '2015-04-13', region: 'us-east-1' });

        if (mode === 's3' || mode === undefined)
            s3 = new aws.S3({ accessKeyId: config.AWS_CC_ACCESS_KEY, secretAccessKey: config.AWS_CC_ACCESS_SECRET, maxRetries: 2 });
    }

    backupProcess().then(() => {
        console.log('\n####################### Completed Github Backup Process #######################\n');
        writeLog('\n####################### Completed Github Backup Process #######################\n');
        return null;
    });
};

function repoUpdated(repo) {
    return (new Date(repo.pushed_at) < new Date(new Date().getTime() - 24 * 60 * 60 * 1000)) ? false : true;
}

async function objectExistsInS3(repo) {
    const exists = await s3
        .headObject({
            Bucket: config.AWS_S3_BUCKET_NAME,
            Key: repo.full_name + ".zip",
        })
        .promise()
        .then(
            () => true,
            err => {
                if (err.code === 'NotFound') {
                    return false;
                }
                throw err;
            }
        );
    return exists;
}

var writeLog = (text) => {
    if (!fs.existsSync(`${config.LOCAL_BACKUP_PATH}/.syncLog`)) {
        fs.writeFile(`${config.LOCAL_BACKUP_PATH}/.syncLog`, `${text}\r\n`, function (err) {
            if (err) throw err;
        });
    } else {
        fs.appendFile(`${config.LOCAL_BACKUP_PATH}/.syncLog`, `${text}\r\n`, function (err) {
            if (err) throw err;
        });
    }
}

exports.writeLog = writeLog;

// //Default repository only
// async function directGitToS3(repo, index, repositoryCount) {
//     try {
//         console.log(`${repo.name} : ${index}/${repositoryCount} : size: ${(repo.size / 1000).toFixed(2)}MB`);
//         const uploader = Promise.promisify(s3.upload.bind(s3));
//         const passThroughStream = new stream.PassThrough();
//         const arhiveURL =
//             `https://api.github.com/repos/${repo.full_name}/zipball/${repo.default_branch}?access_token=${config.GITHUB_ACCESS_TOKEN}`;
//         const requestOptions = {
//             url: arhiveURL,
//             headers: {
//                 "User-Agent": "nodejs",
//                 "Authorization": `token ${config.GITHUB_ACCESS_TOKEN}`,
//             }
//         };
//         await new Promise((resolve, reject) => {
//             request(requestOptions, function (error, response, body) {
//                 if (error) {
//                     reject(error);
//                     throw new Error(error);
//                 }
//                 resolve("done");
//             }).pipe(passThroughStream);
//         });
//         const bucketName = config.AWS_S3_BUCKET_NAME;
//         const objectName = repo.full_name + ".zip";
//         const params = {
//             Bucket: bucketName,
//             Key: objectName,
//             Body: passThroughStream,
//             //StorageClass: options.s3StorageClass || "STANDARD",
//             StorageClass: "STANDARD",
//             ServerSideEncryption: "AES256"
//         };

//         return uploader(params).then(result => {
//             console.log(`[✓] ${repo.full_name} Repository synced to s3.\n`)
//         });
//     } catch (e) {
//         console.log(e);
//     }
// }