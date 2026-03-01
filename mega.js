import * as mega from "megajs";
import fs from "fs";

const auth = {
    email: "mrsenalff@gmail.com",
    password: "SenalFf@11#",
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
};

export const upload = (filePath, fileName) => {
    return new Promise((resolve, reject) => {
        try {
            const storage = new mega.Storage(auth, (err) => {
                if (err) return reject(err);

                const readStream = fs.createReadStream(filePath);
                const uploadStream = storage.upload({
                    name: fileName,
                    allowUploadBuffering: true,
                });

                readStream.pipe(uploadStream);

                uploadStream.on("complete", (file) => {
                    file.link((err, url) => {
                        if (err) return reject(err);
                        storage.close();
                        resolve(url);
                    });
                });

                uploadStream.on("error", (error) => reject(error));
                readStream.on("error", (error) => reject(error));
            });

            storage.on("error", (error) => reject(error));
        } catch (err) {
            reject(err);
        }
    });
};

export const download = (url) => {
    return new Promise((resolve, reject) => {
        try {
            const file = mega.File.fromURL(url);
            file.loadAttributes((err) => {
                if (err) return reject(err);
                file.downloadBuffer((err, buffer) => {
                    if (err) return reject(err);
                    resolve(buffer);
                });
            });
        } catch (err) {
            reject(err);
        }
    });
};
